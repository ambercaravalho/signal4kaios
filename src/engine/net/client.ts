/* Outbound Signal client: device fanout with 409/410 handling, Sealed Sender delivery, retry receipts, attachment upload and download, and identity verification. */

import { constantTimeEqual, fromBase64, toBase64 } from '../bytes';
import { decryptAttachment, encryptAttachment } from '../crypto/attachment';
import { hashSha256, padMessagePlaintext } from '../crypto/primitives';
import {
  AttachmentPointer,
  AttachmentPointerSchema,
  Content,
  ContentSchema,
  Envelope_Type,
  SyncMessage_Request_Type,
} from '../gen/SignalService_pb';
import { create, toBinary } from './proto';
import {
  CIPHERTEXT_PLAINTEXT,
  createSenderKeyDistribution,
  decryptionErrorContent,
  deleteSession,
  encryptForDevice,
  errorCode,
  hasUsableSession,
  localIdentity,
  parsePreKeyResponse,
  processPreKeyBundle,
  safetyNumber,
  sealedEncryptForDevice,
  senderCertificateExpiration,
  senderKeyMultiRecipientEncrypt,
  sessionRegistrationId,
  unidentifiedAccessKey,
} from '../protocol/protocol';
import {
  analyzeSenderKeyDevices,
  GroupSendEndorsements,
  groupSendToken,
  loadSenderKeyInfo,
  rotateSenderKey,
  saveSenderKeyInfo,
  SenderKeyDevice,
} from '../services/group-send';
import type { SignalProtocolStore } from '../protocol/store';
import { accountBasicAuth, asObject, DEFAULT_SIGNAL_SERVER, SIGNAL_CDNS, SignalHttpBinaryFn, SignalHttpJsonFn, SignalHttpRawFn } from './http';
import { isAci } from './proto';
import { type AttachmentDescriptor, attachmentCdnKey, decodeAttachmentDescriptor } from './incoming-json';
import { decryptEnvelope, DecryptedEnvelope, DecryptFailure } from './receive';
import type { TrustLevel } from '../protocol/store';

/** Thrown when a recipient's identity key changed after the user marked it verified: sending waits until the user reviews the new safety number. */
class IdentityChangedError extends Error {
  constructor(readonly recipient: string) {
    super(`Safety number with ${recipient} changed; verify it before sending`);
    this.name = 'UntrustedIdentity';
  }
}

/**
 * High-level SignalClient coordinating outbound encryption, device fanout, attachment upload/download, and identity verification.
 */
/** What a Sender Key send to a group needs: its identifier (base64), its secret params, and its members' group send endorsements. */
export interface SenderKeyGroup {
  internalId: string;
  secretParams: Uint8Array;
  endorsements: GroupSendEndorsements | null;
}

const CONTENT_HINT_DEFAULT = 0;

/** Device IDs from an untrusted 409/410 response list. */
function deviceIds(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
}

export class SignalClient {
  /** Debug log for details the caller can't see, such as a Sender Key send falling back. */
  log: (message: string) => void = () => {};
  private deviceLists = new Map<string, number[]>();
  private profileKeys = new Map<string, Uint8Array>();
  private safetyNumbers = new Map<string, { safetyNumber: string; scannable: string }>();
  private cachedSenderCert: { cert: Uint8Array; expiresAt: number } | null = null;
  private decryptQueue: Promise<any> = Promise.resolve();

  constructor(
    public readonly store: SignalProtocolStore,
    private readonly httpJson: SignalHttpJsonFn,
    private readonly httpBinary: SignalHttpBinaryFn,
    private readonly httpRaw?: SignalHttpRawFn,
    private readonly serverUrl = DEFAULT_SIGNAL_SERVER
  ) {}

  setPeerProfileKey(peerId: string, profileKey: Uint8Array): void {
    if (profileKey && profileKey.length === 32) {
      this.profileKeys.set(peerId, profileKey);
    }
  }

  getPeerProfileKey(peerId: string): Uint8Array | undefined {
    return this.profileKeys.get(peerId);
  }

  /** Drop the cached SenderCertificate, e.g. after our number changed. */
  clearSenderCertificate(): void {
    this.cachedSenderCert = null;
  }

  /** Our server-issued SenderCertificate for Sealed Sender, cached until an hour before it expires. */
  private async getSenderCertificate(): Promise<Uint8Array | null> {
    if (this.cachedSenderCert && this.cachedSenderCert.expiresAt > Date.now()) {
      return this.cachedSenderCert.cert;
    }
    try {
      const auth = await this.authHeader();
      const res = asObject(await this.httpJson('GET', '/v1/certificate/delivery?includeE164=false', null, {
        baseUrl: this.serverUrl,
        basicAuth: auth,
        timeout: 10000,
      }));
      if (res && typeof res.certificate === 'string') {
        const cert = fromBase64(res.certificate);
        this.cachedSenderCert = { cert, expiresAt: senderCertificateExpiration(cert) - 3600 * 1000 };
        return cert;
      }
    } catch {
      // Fall back to identified delivery if the certificate fetch fails
    }
    return null;
  }

  /**
   * Send a PlaintextContent DecryptionErrorMessage retry receipt to the device whose message failed to decrypt, prompting it to resend over a fresh session.
   */
  async sendDecryptionErrorReceipt(failure: DecryptFailure): Promise<void> {
    if (failure.ciphertextType === CIPHERTEXT_PLAINTEXT) return;
    try {
      const auth = await this.authHeader();
      const content = decryptionErrorContent(failure.ciphertext, failure.ciphertextType, failure.timestamp, failure.senderDeviceId);
      await this.httpJson(
        'PUT',
        `/v1/messages/${encodeURIComponent(failure.senderName)}`,
        {
          messages: [
            {
              type: Envelope_Type.PLAINTEXT_CONTENT,
              destinationDeviceId: failure.senderDeviceId,
              destinationRegistrationId: await sessionRegistrationId(this.store, failure.senderName, failure.senderDeviceId),
              content: toBase64(content),
            },
          ],
          timestamp: Date.now(),
          online: false,
          urgent: false,
        },
        { baseUrl: this.serverUrl, basicAuth: auth, timeout: 10000 }
      );
    } catch {
      // Best-effort retry receipt
    }
  }

  private async authHeader(): Promise<{ username: string; password: string; aci: string; number: string; deviceId: number }> {
    const acc = await this.store.getAccount();
    if (!acc) throw new Error('This phone is not linked to a Signal account');
    return {
      ...accountBasicAuth(acc),
      aci: acc.aci,
      number: acc.number,
      deviceId: acc.deviceId,
    };
  }

  /**
   * Enqueue an incoming binary Envelope for strictly serialized decryption. Sends a DecryptionErrorMessage retry receipt when the ciphertext fails to decrypt. `inQueue` runs before the next envelope is decrypted, for content that changes our own keys.
   */
  enqueueDecryptEnvelope(envelopeBytes: Uint8Array, inQueue?: (res: DecryptedEnvelope) => Promise<void>): Promise<DecryptedEnvelope | null> {
    const next = this.decryptQueue.then(async () => {
      try {
        const res = await decryptEnvelope(this.store, envelopeBytes);
        const c = res && res.content.content;
        if (res && c && c.case === 'dataMessage' && c.value.profileKey.length === 32 && res.envelope.sourceUuid) {
          this.setPeerProfileKey(res.envelope.sourceUuid, c.value.profileKey);
        }
        if (res && inQueue) await inQueue(res);
        return res;
      } catch (err) {
        if (err instanceof DecryptFailure) await this.sendDecryptionErrorReceipt(err);
        // A duplicate was already delivered and persisted: drop it so the server can delete it.
        if (errorCode(err) === 'DuplicatedMessage') return null;
        throw err;
      }
    });
    this.decryptQueue = next.catch(() => null);
    return next;
  }

  /** Saves a server-provided identity key before session setup, unless it replaces a key the user verified. */
  private async acceptBundleIdentity(recipientId: string, identityKey: Uint8Array): Promise<void> {
    const existing = await this.store.getIdentity(recipientId);
    if (existing && constantTimeEqual(existing.publicKey, identityKey)) return;
    if (existing && existing.trustLevel === 'TRUSTED_VERIFIED') {
      await this.store.setIdentityTrust(recipientId, 'UNTRUSTED');
      throw new IdentityChangedError(recipientId);
    }
    await this.store.saveIdentity(recipientId, identityKey, { uuid: recipientId });
  }

  /** Fetches PreKey bundles for `selector` (`*` or one device ID) and builds sessions; returns the device IDs that now have sessions. */
  private async fetchAndProcessBundles(recipientId: string, selector: string): Promise<number[]> {
    const auth = await this.authHeader();
    const local = await localIdentity(this.store);
    const res = asObject(await this.httpJson('GET', `/v2/keys/${encodeURIComponent(recipientId)}/${selector}`, null, {
      baseUrl: this.serverUrl,
      basicAuth: auth,
      timeout: 15000,
    }));
    const bundles = parsePreKeyResponse(res);
    if (bundles.length > 0) await this.acceptBundleIdentity(recipientId, bundles[0].identityKey);
    const out: number[] = [];
    for (const b of bundles) {
      if (recipientId === auth.aci && b.deviceId === auth.deviceId) continue;
      await processPreKeyBundle(this.store, local, recipientId, b);
      out.push(b.deviceId);
    }
    return out;
  }

  /** Device IDs to send to: the cached list, else devices we hold sessions with, else everything the server knows (fetching PreKeys). */
  private async devicesFor(recipientId: string): Promise<number[]> {
    const auth = await this.authHeader();
    const notSelf = (d: number) => !(recipientId === auth.aci && d === auth.deviceId);
    const cached = this.deviceLists.get(recipientId);
    if (cached && cached.length > 0) return cached.filter(notSelf);
    const fromSessions = (await this.store.loadSessions(recipientId)).map((s) => s.deviceId).filter(notSelf);
    if (fromSessions.length > 0) return fromSessions;
    try {
      return await this.fetchAndProcessBundles(recipientId, '*');
    } catch (err: any) {
      // Our own account has no other devices to sync to
      if (recipientId === auth.aci && err && err.status === 404) return [];
      throw err;
    }
  }

  private async ensureSession(recipientId: string, deviceId: number): Promise<void> {
    if (await hasUsableSession(this.store, recipientId, deviceId)) return;
    await this.fetchAndProcessBundles(recipientId, String(deviceId));
  }

  /**
   * Encrypt and deliver a Content to all devices of `recipientId` (an ACI) via `PUT /v1/messages/{recipientId}`, using Sealed Sender when we know the recipient's profile key, and handling 409 (missing/extra devices) and 410 (stale devices) by updating sessions and retrying. Resolves to whether it went sealed.
   */
  async sendContentToRecipient(recipientId: string, content: Content, timestamp: number, online = false, urgent = !online): Promise<boolean> {
    if (!isAci(recipientId)) throw new Error('Signal recipients are addressed by ACI; unknown service ID ' + recipientId);
    const auth = await this.authHeader();
    const local = await localIdentity(this.store);
    const plainBytes = padMessagePlaintext(toBinary(ContentSchema, content));

    const peerProfileKey = recipientId !== auth.aci ? this.getPeerProfileKey(recipientId) : undefined;
    let senderCert: Uint8Array | null = null;
    let accessKey: string | undefined;
    if (peerProfileKey) {
      senderCert = await this.getSenderCertificate();
      if (senderCert) accessKey = unidentifiedAccessKey(peerProfileKey);
    }

    let devices = await this.devicesFor(recipientId);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (devices.length === 0) return false;
      const messages = [];
      for (const devId of devices) {
        await this.ensureSession(recipientId, devId);
        if (senderCert && accessKey) {
          const sealed = await sealedEncryptForDevice(this.store, local, recipientId, devId, senderCert, plainBytes);
          messages.push({
            type: Envelope_Type.UNIDENTIFIED_SENDER,
            destinationDeviceId: devId,
            destinationRegistrationId: sealed.registrationId,
            content: toBase64(sealed.body),
          });
        } else {
          const enc = await encryptForDevice(this.store, local, recipientId, devId, plainBytes);
          messages.push({
            type: enc.envelopeType,
            destinationDeviceId: devId,
            destinationRegistrationId: enc.registrationId,
            content: toBase64(enc.body),
          });
        }
      }

      try {
        await this.httpJson(
          'PUT',
          `/v1/messages/${encodeURIComponent(recipientId)}`,
          { messages, timestamp, online, urgent },
          accessKey
            ? { baseUrl: this.serverUrl, noAuth: true, headers: { 'Unidentified-Access-Key': accessKey }, timeout: 20000 }
            : { baseUrl: this.serverUrl, basicAuth: auth, timeout: 20000 }
        );
        this.deviceLists.set(recipientId, devices);
        return !!accessKey;
      } catch (err: any) {
        const fixed = await this.fixDevices(recipientId, err && err.status, err && err.body, devices);
        if (fixed) {
          devices = fixed.devices;
          continue;
        }
        if (err && err.status === 401 && accessKey) {
          // Wrong or outdated profile key: retry identified
          accessKey = undefined;
          senderCert = null;
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  /**
   * Send a group Content to every member. With `group` and its endorsements, members with an endorsement get one Sender Key message through `PUT /v1/messages/multi_recipient`; everyone else, and everyone when that fails, gets individual Sealed Sender (or identified) 1:1 messages. Errors for single members are collected; the call fails only if no member received it. Resolves to whether every member got it sealed.
   */
  async sendGroupContent(recipients: string[], content: Content, timestamp: number, online = false, group?: SenderKeyGroup): Promise<boolean> {
    const auth = await this.authHeader();
    const targets = Array.from(new Set(recipients.filter((p) => p && p !== auth.aci && isAci(p))));
    let pairwise = targets;
    let sealed = 0;
    let delivered = 0;
    if (group && group.endorsements && targets.length > 0) {
      try {
        const res = await this.sendViaSenderKey(group, group.endorsements, targets, content, timestamp, online);
        sealed = delivered = res.sent.length;
        pairwise = targets.filter((t) => !res.sent.includes(t) && !res.unregistered.includes(t));
      } catch (err: any) {
        this.log('sender key send failed, sending to each member: ' + (err && (err.status || err.message)));
      }
    }
    let lastError: unknown = null;
    for (const peer of pairwise) {
      try {
        if (await this.sendContentToRecipient(peer, content, timestamp, online)) sealed++;
        delivered++;
      } catch (err) {
        lastError = err;
      }
    }
    if (targets.length > 0 && delivered === 0 && lastError) throw lastError;
    return targets.length > 0 && sealed === targets.length;
  }

  /** Every device of `aci` with a session ready, each with its registration ID. */
  private async senderKeyDevices(aci: string): Promise<SenderKeyDevice[]> {
    const out: SenderKeyDevice[] = [];
    for (const deviceId of await this.devicesFor(aci)) {
      await this.ensureSession(aci, deviceId);
      out.push({ aci, deviceId, registrationId: await sessionRegistrationId(this.store, aci, deviceId) });
    }
    return out;
  }

  /** Applies a 409 (mismatched devices) or 410 (stale devices) response for `aci`: drops the sessions it names and returns the corrected device list. Null for any other error. */
  private async fixDevices(aci: string, status: unknown, body: any, current: number[]): Promise<{ devices: number[]; missing: number[]; stale: number[] } | null> {
    if (!body || typeof body !== 'object') return null;
    if (status === 409) {
      const extra = deviceIds(body.extraDevices);
      const missing = deviceIds(body.missingDevices);
      for (const ex of extra) await deleteSession(this.store, aci, ex);
      const devices = current.filter((d) => !extra.includes(d)).concat(missing.filter((d) => !current.includes(d)));
      this.deviceLists.set(aci, devices);
      return { devices, missing, stale: [] };
    }
    if (status === 410) {
      const stale = deviceIds(body.staleDevices);
      for (const st of stale) await deleteSession(this.store, aci, st);
      return { devices: current, missing: [], stale };
    }
    return null;
  }

  /**
   * One Sender Key message for the members we hold endorsements for, as Signal-Desktop's sendToGroupViaSenderKey: rotate the key when someone left, send our SenderKeyDistributionMessage to devices that don't have it yet, then seal the message for every device at once. A 409 or 410 (device lists out of date) is fixed and retried once; anything else throws so the caller sends one by one.
   */
  private async sendViaSenderKey(
    group: SenderKeyGroup,
    endorsements: GroupSendEndorsements,
    targets: string[],
    content: Content,
    timestamp: number,
    online: boolean
  ): Promise<{ sent: string[]; unregistered: string[] }> {
    const members = targets.filter((a) => !!endorsements.members[a]);
    if (members.length < 2) throw new Error('Not enough recipients for a Sender Key message');
    const senderCert = await this.getSenderCertificate();
    if (!senderCert) throw new Error('No sender certificate');
    const local = await localIdentity(this.store);
    const plain = padMessagePlaintext(toBinary(ContentSchema, content));

    for (let attempt = 0; ; attempt++) {
      const devices: SenderKeyDevice[] = [];
      const reached: string[] = [];
      for (const aci of members) {
        try {
          const list = await this.senderKeyDevices(aci);
          if (list.length) reached.push(aci);
          devices.push(...list);
        } catch (err: any) {
          this.log('no devices for a group member: ' + (err && (err.status || err.message)));
        }
      }
      if (reached.length < 2) throw new Error('Not enough recipients for a Sender Key message');

      let info = await loadSenderKeyInfo(this.store, group.internalId);
      let seen = analyzeSenderKeyDevices(info.memberDevices, devices);
      if (seen.removedAcis.some((a) => !targets.includes(a))) {
        info = await rotateSenderKey(this.store, group.internalId);
        seen = analyzeSenderKeyDevices([], devices);
      } else if (seen.removedDevices.length) {
        info.memberDevices = info.memberDevices.filter((m) => !seen.removedDevices.includes(m));
        await saveSenderKeyInfo(this.store, group.internalId, info);
      }
      const skdm = await createSenderKeyDistribution(this.store, local, info.distributionId);
      if (seen.newAcis.length) {
        const skdmContent = create(ContentSchema, { senderKeyDistributionMessage: skdm });
        for (const aci of seen.newAcis) await this.sendContentToRecipient(aci, skdmContent, Date.now());
        info.memberDevices = info.memberDevices.concat(seen.newDevices);
        await saveSenderKeyInfo(this.store, group.internalId, info);
      }

      const body = await senderKeyMultiRecipientEncrypt(
        this.store,
        local,
        info.distributionId,
        devices.map((d) => ({ name: d.aci, deviceId: d.deviceId })),
        senderCert,
        plain,
        CONTENT_HINT_DEFAULT,
        fromBase64(group.internalId)
      );
      const token = groupSendToken(endorsements, group.secretParams, reached);
      try {
        const res = asObject(await this.httpJson('PUT', `/v1/messages/multi_recipient?ts=${timestamp}&online=${online}&urgent=${!online}&story=false`, body, {
          baseUrl: this.serverUrl,
          noAuth: true,
          headers: { 'Content-Type': 'application/vnd.signal-messenger.mrm', 'Group-Send-Token': token },
          timeout: 20000,
        }));
        const unregistered: string[] = res && Array.isArray(res.uuids404) ? res.uuids404.filter((id: unknown) => typeof id === 'string' && reached.includes(id)) : [];
        for (const aci of unregistered) this.deviceLists.delete(aci);
        return { sent: reached.filter((a) => !unregistered.includes(a)), unregistered };
      } catch (err: any) {
        const status = err && err.status;
        const entries: any[] = err && Array.isArray(err.body) ? err.body : [];
        if (attempt > 0 || (status !== 409 && status !== 410) || !entries.length) throw err;
        for (const entry of entries) {
          const aci = entry && typeof entry.uuid === 'string' ? entry.uuid : '';
          if (!reached.includes(aci)) continue;
          const current = devices.filter((x) => x.aci === aci).map((x) => x.deviceId);
          const fixed = await this.fixDevices(aci, status, entry.devices, current);
          if (!fixed) continue;
          for (const d of fixed.missing.concat(fixed.stale)) await this.fetchAndProcessBundles(aci, String(d));
          if (fixed.stale.length) {
            info.memberDevices = info.memberDevices.filter((m) => !(m.aci === aci && fixed.stale.includes(m.deviceId)));
            await saveSenderKeyInfo(this.store, group.internalId, info);
          }
        }
      }
    }
  }

  /**
   * Send a SyncMessage to our own primary/linked devices so sent messages and read state stay in sync.
   */
  async sendSyncMessage(syncContent: Content, timestamp = Date.now()): Promise<void> {
    const auth = await this.authHeader();
    try {
      await this.sendContentToRecipient(auth.aci, syncContent, timestamp);
    } catch {
      // Best-effort sync to sibling linked devices
    }
  }

  /**
   * Request Contacts, Blocked, Configuration, and Keys (account entropy pool / master key) sync from the primary device.
   */
  async requestInitialSync(): Promise<void> {
    const types = [
      SyncMessage_Request_Type.CONTACTS,
      SyncMessage_Request_Type.BLOCKED,
      SyncMessage_Request_Type.CONFIGURATION,
      SyncMessage_Request_Type.KEYS,
    ];
    for (const type of types) {
      await this.sendSyncMessage(
        create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'request', value: { type } } } } })
      );
    }
  }

  /**
   * Download and decrypt an attachment from the Signal CDN named by its pointer, stripping Signal's size padding.
   */
  async downloadAttachment(descriptorIdOrPointer: string | AttachmentPointer): Promise<{ bytes: Uint8Array; contentType: string }> {
    let desc: AttachmentDescriptor | null;
    if (typeof descriptorIdOrPointer === 'string') {
      desc = decodeAttachmentDescriptor(descriptorIdOrPointer);
    } else {
      const p = descriptorIdOrPointer;
      desc = {
        cdnKey: attachmentCdnKey(p),
        cdnNumber: p.cdnNumber || 0,
        key: p.key,
        digest: p.digest.length ? p.digest : undefined,
        contentType: p.contentType || 'application/octet-stream',
        fileName: p.fileName,
        size: p.size,
      };
    }
    if (!desc || !desc.cdnKey) throw new Error('Invalid attachment descriptor');
    if (desc.key.length !== 64) throw new Error('Attachment pointer missing key');
    const cdnBase = SIGNAL_CDNS[desc.cdnNumber];
    if (!cdnBase) throw new Error('Unknown attachment CDN ' + desc.cdnNumber);

    const encryptedBytes = await this.httpBinary('GET', `${cdnBase}/attachments/${encodeURIComponent(desc.cdnKey)}`, null, {}, 60000);
    const decrypted = await decryptAttachment(encryptedBytes, desc.key, desc.digest);
    const bytes = desc.size > 0 && desc.size <= decrypted.length ? decrypted.subarray(0, desc.size) : decrypted;
    if (!desc.digest && desc.plaintextHash && !constantTimeEqual(hashSha256(bytes), desc.plaintextHash)) throw new Error('Attachment plaintext hash mismatch');
    return { bytes, contentType: desc.contentType };
  }

  /**
   * Encrypt and upload an attachment like Signal-Desktop: pad, encrypt, fetch a `GET /v4/attachments/form/upload` form, then upload with TUS (CDN 3) or a resumable PUT (CDN 2).
   */
  async uploadAttachment(plaintext: Uint8Array, contentType: string, fileName: string): Promise<AttachmentPointer> {
    const auth = await this.authHeader();
    const encrypted = await encryptAttachment(plaintext);
    const size = encrypted.ciphertext.length;

    const form = asObject(await this.httpJson('GET', `/v4/attachments/form/upload?uploadLength=${size}`, null, {
      baseUrl: this.serverUrl,
      basicAuth: auth,
      timeout: 15000,
    }));
    if (!form || typeof form.key !== 'string' || typeof form.signedUploadLocation !== 'string' || typeof form.cdn !== 'number') {
      throw new Error('Signal server returned an invalid attachment upload form');
    }
    const formHeaders: Record<string, string> = {};
    const headers = asObject(form.headers);
    if (headers) {
      for (const k of Object.keys(headers)) {
        const v = headers[k];
        if (typeof v === 'string') formHeaders[k] = v;
      }
    }

    if (form.cdn === 3) {
      await this.httpBinary(
        'POST',
        form.signedUploadLocation,
        encrypted.ciphertext,
        {
          ...formHeaders,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(size),
          'Upload-Metadata': 'filename ' + toBase64(new TextEncoder().encode(form.key)),
          'Content-Type': 'application/offset+octet-stream',
        },
        120000
      );
    } else {
      if (!this.httpRaw) throw new Error('CDN ' + form.cdn + ' uploads need a raw HTTP transport');
      const start = await this.httpRaw('POST', form.signedUploadLocation, null, formHeaders, 30000);
      if (!start.location) throw new Error('Attachment upload form returned no upload location');
      await this.httpBinary('PUT', start.location, encrypted.ciphertext, { 'Content-Range': `bytes 0-*/${size}` }, 120000);
    }

    return create(AttachmentPointerSchema, {
      attachmentIdentifier: { case: 'cdnKey', value: form.key },
      cdnNumber: form.cdn,
      contentType,
      key: encrypted.key,
      size: plaintext.length,
      digest: encrypted.digest,
      fileName,
      uploadTimestamp: BigInt(Date.now()),
    });
  }

  /** One contact's safety number and trust, for the safety number screen. The fingerprint is cached per pair of identity keys, since it takes seconds on a phone. */
  async safetyNumberFor(aci: string): Promise<{
    uuid: string;
    number?: string;
    safety_number: string;
    scannable_safety_number: string;
    trust_level: TrustLevel;
    added_timestamp: number;
  } | null> {
    const acc = await this.store.getAccount();
    if (!acc || !isAci(aci) || aci === acc.aci) return null;
    const id = (await this.store.getIdentity(aci)) || (await this.store.getAllIdentities()).find((r) => r.uuid === aci) || null;
    if (!id) return null;
    const cacheKey = aci + ':' + toBase64(acc.aciIdentityKeyPair.pubKey) + ':' + toBase64(id.publicKey);
    let sn = this.safetyNumbers.get(cacheKey);
    if (!sn) {
      const r = safetyNumber(acc.aci, acc.aciIdentityKeyPair.pubKey, aci, id.publicKey);
      sn = { safetyNumber: r.safetyNumber, scannable: toBase64(r.scannable) };
      this.safetyNumbers.set(cacheKey, sn);
    }
    return {
      uuid: aci,
      number: id.number,
      safety_number: sn.safetyNumber,
      scannable_safety_number: sn.scannable,
      trust_level: id.trustLevel,
      added_timestamp: id.addedTimestamp,
    };
  }
}
