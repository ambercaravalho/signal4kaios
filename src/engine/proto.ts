/* Binary protobuf wire-format codec and Signal Protocol message schemas.
 * Zero-eval, CSP-clean implementation for Gecko 84+ (KaiOS 3.0 / 3.1 / 4.0) and Node.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

export class ProtoWriter {
  private chunks: number[] = [];

  writeVarint(value: number | bigint): this {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) {
      v = BigInt.asUintN(64, v);
    }
    while (v >= 0x80n) {
      this.chunks.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.chunks.push(Number(v));
    return this;
  }

  writeTag(fieldNumber: number, wireType: number): this {
    return this.writeVarint((fieldNumber << 3) | wireType);
  }

  writeUint32(fieldNumber: number, value?: number | null): this {
    if (value === undefined || value === null) return this;
    this.writeTag(fieldNumber, WIRE_VARINT);
    return this.writeVarint(value >>> 0);
  }

  writeUint64(fieldNumber: number, value?: number | bigint | null): this {
    if (value === undefined || value === null) return this;
    this.writeTag(fieldNumber, WIRE_VARINT);
    return this.writeVarint(typeof value === 'bigint' ? value : BigInt(Math.trunc(value)));
  }

  writeBool(fieldNumber: number, value?: boolean | null): this {
    if (value === undefined || value === null) return this;
    this.writeTag(fieldNumber, WIRE_VARINT);
    return this.writeVarint(value ? 1 : 0);
  }

  writeFixed64(fieldNumber: number, value?: number | bigint | null): this {
    if (value === undefined || value === null) return this;
    this.writeTag(fieldNumber, WIRE_FIXED64);
    let v = BigInt.asUintN(64, typeof value === 'bigint' ? value : BigInt(Math.trunc(value)));
    for (let i = 0; i < 8; i++) {
      this.chunks.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return this;
  }

  writeBytes(fieldNumber: number, value?: Uint8Array | null): this {
    if (!value) return this;
    this.writeTag(fieldNumber, WIRE_BYTES);
    this.writeVarint(value.length);
    for (let i = 0; i < value.length; i++) {
      this.chunks.push(value[i]);
    }
    return this;
  }

  writeString(fieldNumber: number, value?: string | null): this {
    if (value === undefined || value === null) return this;
    const encoded = new TextEncoder().encode(value);
    return this.writeBytes(fieldNumber, encoded);
  }

  writeMessage<T>(fieldNumber: number, value: T | undefined | null, encoder: (val: T, w: ProtoWriter) => void): this {
    if (value === undefined || value === null) return this;
    const sub = new ProtoWriter();
    encoder(value, sub);
    return this.writeBytes(fieldNumber, sub.finish());
  }

  finish(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

export class ProtoReader {
  public pos = 0;
  public readonly len: number;

  constructor(public readonly buf: Uint8Array, offset = 0, length?: number) {
    this.pos = offset;
    this.len = length !== undefined ? offset + length : buf.length;
  }

  eof(): boolean {
    return this.pos >= this.len;
  }

  readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.len) {
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 64n) throw new Error('Malformed varint');
    }
    throw new Error('Unexpected EOF reading varint');
  }

  readVarintNumber(): number {
    return Number(this.readVarintBig());
  }

  readUint32(): number {
    return Number(this.readVarintBig() & 0xffffffffn) >>> 0;
  }

  readBool(): boolean {
    return this.readVarintBig() !== 0n;
  }

  readFixed64Big(): bigint {
    if (this.pos + 8 > this.len) throw new Error('Unexpected EOF reading fixed64');
    let v = 0n;
    for (let i = 0; i < 8; i++) {
      v |= BigInt(this.buf[this.pos++]) << BigInt(i * 8);
    }
    return v;
  }

  readFixed64Number(): number {
    return Number(this.readFixed64Big());
  }

  readFixed32(): number {
    if (this.pos + 4 > this.len) throw new Error('Unexpected EOF reading fixed32');
    const v =
      this.buf[this.pos] |
      (this.buf[this.pos + 1] << 8) |
      (this.buf[this.pos + 2] << 16) |
      (this.buf[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readUint32();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x07 };
  }

  readBytes(): Uint8Array {
    const length = this.readUint32();
    if (this.pos + length > this.len) throw new Error('Unexpected EOF reading bytes');
    const out = this.buf.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarintBig();
        break;
      case WIRE_FIXED64:
        if (this.pos + 8 > this.len) throw new Error('Unexpected EOF skipping fixed64');
        this.pos += 8;
        break;
      case WIRE_BYTES: {
        const l = this.readUint32();
        if (this.pos + l > this.len) throw new Error('Unexpected EOF skipping bytes');
        this.pos += l;
        break;
      }
      case WIRE_FIXED32:
        if (this.pos + 4 > this.len) throw new Error('Unexpected EOF skipping fixed32');
        this.pos += 4;
        break;
      default:
        throw new Error('Unsupported protobuf wireType ' + wireType);
    }
  }
}

/* ============================================================================
 * 1. WebSocketResources.proto
 * ============================================================================ */

export interface WebSocketRequestMessage {
  verb?: string;
  path?: string;
  body?: Uint8Array;
  headers: string[];
  id?: bigint;
}

export interface WebSocketResponseMessage {
  id?: bigint;
  status?: number;
  message?: string;
  headers: string[];
  body?: Uint8Array;
}

export enum WebSocketMessageType {
  UNKNOWN = 0,
  REQUEST = 1,
  RESPONSE = 2,
}

export interface WebSocketMessage {
  type?: WebSocketMessageType;
  request?: WebSocketRequestMessage;
  response?: WebSocketResponseMessage;
}

export function encodeWebSocketRequest(msg: WebSocketRequestMessage, w = new ProtoWriter()): Uint8Array {
  w.writeString(1, msg.verb);
  w.writeString(2, msg.path);
  w.writeBytes(3, msg.body);
  if (msg.id !== undefined) w.writeUint64(4, msg.id);
  for (const h of msg.headers || []) w.writeString(5, h);
  return w.finish();
}

export function decodeWebSocketRequest(buf: Uint8Array): WebSocketRequestMessage {
  const r = new ProtoReader(buf);
  const out: WebSocketRequestMessage = { headers: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.verb = r.readString(); break;
      case 2: out.path = r.readString(); break;
      case 3: out.body = r.readBytes(); break;
      case 4: out.id = r.readVarintBig(); break;
      case 5: out.headers.push(r.readString()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function encodeWebSocketResponse(msg: WebSocketResponseMessage, w = new ProtoWriter()): Uint8Array {
  if (msg.id !== undefined) w.writeUint64(1, msg.id);
  w.writeUint32(2, msg.status);
  w.writeString(3, msg.message);
  if (msg.body) w.writeBytes(4, msg.body);
  for (const h of msg.headers || []) w.writeString(5, h);
  return w.finish();
}

export function decodeWebSocketResponse(buf: Uint8Array): WebSocketResponseMessage {
  const r = new ProtoReader(buf);
  const out: WebSocketResponseMessage = { headers: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.id = r.readVarintBig(); break;
      case 2: out.status = r.readUint32(); break;
      case 3: out.message = r.readString(); break;
      case 4: out.body = r.readBytes(); break;
      case 5: out.headers.push(r.readString()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function encodeWebSocketMessage(msg: WebSocketMessage): Uint8Array {
  const w = new ProtoWriter();
  w.writeUint32(1, msg.type);
  if (msg.request) w.writeBytes(2, encodeWebSocketRequest(msg.request));
  if (msg.response) w.writeBytes(3, encodeWebSocketResponse(msg.response));
  return w.finish();
}

export function decodeWebSocketMessage(buf: Uint8Array): WebSocketMessage {
  const r = new ProtoReader(buf);
  const out: WebSocketMessage = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.type = r.readUint32() as WebSocketMessageType; break;
      case 2: out.request = decodeWebSocketRequest(r.readBytes()); break;
      case 3: out.response = decodeWebSocketResponse(r.readBytes()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

/* ============================================================================
 * 2. Provisioning.proto
 * ============================================================================ */

export interface ProvisioningUuid {
  uuid: string;
}

export function decodeProvisioningUuid(buf: Uint8Array): ProvisioningUuid {
  const r = new ProtoReader(buf);
  let uuid = '';
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1) uuid = r.readString();
    else r.skipField(wireType);
  }
  return { uuid };
}

export interface ProvisionEnvelope {
  publicKey?: Uint8Array;
  body?: Uint8Array;
}

export function encodeProvisionEnvelope(msg: ProvisionEnvelope): Uint8Array {
  const w = new ProtoWriter();
  w.writeBytes(1, msg.publicKey);
  w.writeBytes(2, msg.body);
  return w.finish();
}

export function decodeProvisionEnvelope(buf: Uint8Array): ProvisionEnvelope {
  const r = new ProtoReader(buf);
  const out: ProvisionEnvelope = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.publicKey = r.readBytes(); break;
      case 2: out.body = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface ProvisionMessage {
  aciIdentityKeyPublic?: Uint8Array;
  aciIdentityKeyPrivate?: Uint8Array;
  number?: string;
  provisioningCode?: string;
  userAgent?: string;
  profileKey?: Uint8Array;
  readReceipts?: boolean;
  provisioningVersion?: number;
  aci?: string;
  pni?: string;
  pniIdentityKeyPublic?: Uint8Array;
  pniIdentityKeyPrivate?: Uint8Array;
  masterKey?: Uint8Array;
}

export function encodeProvisionMessage(msg: ProvisionMessage): Uint8Array {
  const w = new ProtoWriter();
  w.writeBytes(1, msg.aciIdentityKeyPublic);
  w.writeBytes(2, msg.aciIdentityKeyPrivate);
  w.writeString(3, msg.number);
  w.writeString(4, msg.provisioningCode);
  w.writeString(5, msg.userAgent);
  w.writeBytes(6, msg.profileKey);
  w.writeBool(7, msg.readReceipts);
  w.writeUint32(9, msg.provisioningVersion);
  w.writeString(8, msg.aci);
  w.writeString(10, msg.pni);
  w.writeBytes(11, msg.pniIdentityKeyPublic);
  w.writeBytes(12, msg.pniIdentityKeyPrivate);
  w.writeBytes(13, msg.masterKey);
  return w.finish();
}

export function decodeProvisionMessage(buf: Uint8Array): ProvisionMessage {
  const r = new ProtoReader(buf);
  const out: ProvisionMessage = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.aciIdentityKeyPublic = r.readBytes(); break;
      case 2: out.aciIdentityKeyPrivate = r.readBytes(); break;
      case 3: out.number = r.readString(); break;
      case 4: out.provisioningCode = r.readString(); break;
      case 5: out.userAgent = r.readString(); break;
      case 6: out.profileKey = r.readBytes(); break;
      case 7: out.readReceipts = r.readBool(); break;
      case 8: out.aci = r.readString(); break;
      case 9: out.provisioningVersion = r.readUint32(); break;
      case 10: out.pni = r.readString(); break;
      case 11: out.pniIdentityKeyPublic = r.readBytes(); break;
      case 12: out.pniIdentityKeyPrivate = r.readBytes(); break;
      case 13: out.masterKey = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

/* ============================================================================
 * 3. SubProtocol.proto (SignalMessage, PreKeySignalMessage, SenderKeyMessage)
 * ============================================================================ */

export interface SignalMessageProto {
  ratchetKey?: Uint8Array;
  counter?: number;
  previousCounter?: number;
  ciphertext?: Uint8Array;
}

export function encodeSignalMessageProto(msg: SignalMessageProto): Uint8Array {
  const w = new ProtoWriter();
  w.writeBytes(1, msg.ratchetKey);
  w.writeUint32(2, msg.counter);
  w.writeUint32(3, msg.previousCounter);
  w.writeBytes(4, msg.ciphertext);
  return w.finish();
}

export function decodeSignalMessageProto(buf: Uint8Array): SignalMessageProto {
  const r = new ProtoReader(buf);
  const out: SignalMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.ratchetKey = r.readBytes(); break;
      case 2: out.counter = r.readUint32(); break;
      case 3: out.previousCounter = r.readUint32(); break;
      case 4: out.ciphertext = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface PreKeySignalMessageProto {
  registrationId?: number;
  preKeyId?: number;
  signedPreKeyId?: number;
  kyberPreKeyId?: number;
  kyberCiphertext?: Uint8Array;
  baseKey?: Uint8Array;
  identityKey?: Uint8Array;
  message?: Uint8Array; // serialized SignalMessage with version/MAC
}

export function encodePreKeySignalMessageProto(msg: PreKeySignalMessageProto): Uint8Array {
  const w = new ProtoWriter();
  if (msg.preKeyId !== undefined) w.writeUint32(1, msg.preKeyId);
  w.writeBytes(2, msg.baseKey);
  w.writeBytes(3, msg.identityKey);
  w.writeBytes(4, msg.message);
  w.writeUint32(5, msg.registrationId);
  w.writeUint32(6, msg.signedPreKeyId);
  if (msg.kyberPreKeyId !== undefined) w.writeUint32(7, msg.kyberPreKeyId);
  if (msg.kyberCiphertext) w.writeBytes(8, msg.kyberCiphertext);
  return w.finish();
}

export function decodePreKeySignalMessageProto(buf: Uint8Array): PreKeySignalMessageProto {
  const r = new ProtoReader(buf);
  const out: PreKeySignalMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.preKeyId = r.readUint32(); break;
      case 2: out.baseKey = r.readBytes(); break;
      case 3: out.identityKey = r.readBytes(); break;
      case 4: out.message = r.readBytes(); break;
      case 5: out.registrationId = r.readUint32(); break;
      case 6: out.signedPreKeyId = r.readUint32(); break;
      case 7: out.kyberPreKeyId = r.readUint32(); break;
      case 8: out.kyberCiphertext = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface DecryptionErrorMessageProto {
  ratchetKey?: Uint8Array;
  timestamp?: number;
  deviceId?: number;
}

export interface PlaintextContentProto {
  decryptionErrorMessage?: DecryptionErrorMessageProto;
}

export function encodePlaintextContentProto(msg: PlaintextContentProto): Uint8Array {
  const body = new ProtoWriter();
  if (msg.decryptionErrorMessage) {
    body.writeMessage(1, msg.decryptionErrorMessage, (dem, dw) => {
      dw.writeBytes(1, dem.ratchetKey);
      dw.writeUint64(2, dem.timestamp);
      dw.writeUint32(3, dem.deviceId);
    });
  }
  const protoBytes = body.finish();
  const out = new Uint8Array(1 + protoBytes.length);
  out[0] = 0x00; // PlaintextContent version byte
  out.set(protoBytes, 1);
  return out;
}

export function decodePlaintextContentProto(buf: Uint8Array): PlaintextContentProto {
  const offset = buf.length > 0 && buf[0] === 0x00 ? 1 : 0;
  const r = new ProtoReader(buf, offset);
  const out: PlaintextContentProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1) {
      const dr = new ProtoReader(r.readBytes());
      const dem: DecryptionErrorMessageProto = {};
      while (!dr.eof()) {
        const dt = dr.readTag();
        switch (dt.fieldNumber) {
          case 1: dem.ratchetKey = dr.readBytes(); break;
          case 2: dem.timestamp = dr.readVarintNumber(); break;
          case 3: dem.deviceId = dr.readUint32(); break;
          default: dr.skipField(dt.wireType);
        }
      }
      out.decryptionErrorMessage = dem;
    } else {
      r.skipField(wireType);
    }
  }
  return out;
}

export interface SenderKeyDistributionMessageProto {
  id?: number;
  iteration?: number;
  chainKey?: Uint8Array;
  signingKey?: Uint8Array;
}

export function encodeSenderKeyDistributionProto(msg: SenderKeyDistributionMessageProto): Uint8Array {
  const w = new ProtoWriter();
  w.writeUint32(1, msg.id);
  w.writeUint32(2, msg.iteration);
  w.writeBytes(3, msg.chainKey);
  w.writeBytes(4, msg.signingKey);
  return w.finish();
}

export function decodeSenderKeyDistributionProto(buf: Uint8Array): SenderKeyDistributionMessageProto {
  const r = new ProtoReader(buf);
  const out: SenderKeyDistributionMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.id = r.readUint32(); break;
      case 2: out.iteration = r.readUint32(); break;
      case 3: out.chainKey = r.readBytes(); break;
      case 4: out.signingKey = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface SenderKeyMessageProto {
  id?: number;
  iteration?: number;
  ciphertext?: Uint8Array;
}

export function encodeSenderKeyMessageProto(msg: SenderKeyMessageProto): Uint8Array {
  const w = new ProtoWriter();
  w.writeUint32(1, msg.id);
  w.writeUint32(2, msg.iteration);
  w.writeBytes(3, msg.ciphertext);
  return w.finish();
}

export function decodeSenderKeyMessageProto(buf: Uint8Array): SenderKeyMessageProto {
  const r = new ProtoReader(buf);
  const out: SenderKeyMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.id = r.readUint32(); break;
      case 2: out.iteration = r.readUint32(); break;
      case 3: out.ciphertext = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

/* ============================================================================
 * 4. UnidentifiedDelivery.proto (Sealed Sender)
 * ============================================================================ */

export interface ServerCertificate {
  certificate?: Uint8Array;
  signature?: Uint8Array;
}

export interface SenderCertificate {
  certificate?: Uint8Array;
  signature?: Uint8Array;
}

export interface SenderCertificateDetails {
  senderE164?: string;
  senderUuid?: string;
  senderDevice?: number;
  expires?: number;
  identityKey?: Uint8Array;
  signer?: ServerCertificate;
}

export enum UnidentifiedMessageType {
  PREKEY_MESSAGE = 1,
  MESSAGE = 2,
  PREKEY_OVERHEAD = 3,
  PLAINTEXT_CONTENT = 8,
}

export interface UnidentifiedSenderMessageContent {
  type?: number;
  senderCertificate?: SenderCertificate;
  content?: Uint8Array;
  contentHint?: number;
  groupId?: Uint8Array;
}

export interface UnidentifiedSenderMessage {
  ephemeralPublic?: Uint8Array;
  encryptedStatic?: Uint8Array;
  encryptedMessage?: Uint8Array;
}

export function encodeSenderCertificate(msg: SenderCertificate): Uint8Array {
  const w = new ProtoWriter();
  w.writeBytes(1, msg.certificate);
  w.writeBytes(2, msg.signature);
  return w.finish();
}

export function decodeSenderCertificate(buf: Uint8Array): SenderCertificate {
  const r = new ProtoReader(buf);
  const out: SenderCertificate = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.certificate = r.readBytes(); break;
      case 2: out.signature = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function decodeSenderCertificateDetails(buf: Uint8Array): SenderCertificateDetails {
  const r = new ProtoReader(buf);
  const out: SenderCertificateDetails = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.senderE164 = r.readString(); break;
      case 2: out.senderDevice = r.readUint32(); break;
      case 3: out.expires = r.readFixed64Number(); break;
      case 4: out.identityKey = r.readBytes(); break;
      case 6: out.senderUuid = r.readString(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function encodeUnidentifiedSenderMessageContent(msg: UnidentifiedSenderMessageContent): Uint8Array {
  const w = new ProtoWriter();
  w.writeUint32(1, msg.type);
  if (msg.senderCertificate) w.writeBytes(2, encodeSenderCertificate(msg.senderCertificate));
  w.writeBytes(3, msg.content);
  w.writeUint32(4, msg.contentHint);
  w.writeBytes(5, msg.groupId);
  return w.finish();
}

export function decodeUnidentifiedSenderMessageContent(buf: Uint8Array): UnidentifiedSenderMessageContent {
  const r = new ProtoReader(buf);
  const out: UnidentifiedSenderMessageContent = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.type = r.readUint32(); break;
      case 2: out.senderCertificate = decodeSenderCertificate(r.readBytes()); break;
      case 3: out.content = r.readBytes(); break;
      case 4: out.contentHint = r.readUint32(); break;
      case 5: out.groupId = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function encodeUnidentifiedSenderMessage(msg: UnidentifiedSenderMessage): Uint8Array {
  const w = new ProtoWriter();
  w.writeBytes(1, msg.ephemeralPublic);
  w.writeBytes(2, msg.encryptedStatic);
  w.writeBytes(3, msg.encryptedMessage);
  return w.finish();
}

export function decodeUnidentifiedSenderMessage(buf: Uint8Array): UnidentifiedSenderMessage {
  const r = new ProtoReader(buf);
  const out: UnidentifiedSenderMessage = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.ephemeralPublic = r.readBytes(); break;
      case 2: out.encryptedStatic = r.readBytes(); break;
      case 3: out.encryptedMessage = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

/* ============================================================================
 * 5. SignalService.proto (Envelope, Content, DataMessage, SyncMessage, etc.)
 * ============================================================================ */

export enum EnvelopeType {
  UNKNOWN = 0,
  CIPHERTEXT = 1,
  KEY_EXCHANGE = 2,
  PREKEY_BUNDLE = 3,
  RECEIPT = 5,
  UNIDENTIFIED_SENDER = 6,
  SENDERKEY_MESSAGE = 7,
  PLAINTEXT_CONTENT = 8,
}

export interface Envelope {
  type?: EnvelopeType;
  sourceE164?: string;
  sourceUuid?: string;
  sourceDevice?: number;
  destinationUuid?: string;
  timestamp?: number;
  legacyMessage?: Uint8Array;
  content?: Uint8Array;
  serverGuid?: string;
  serverTimestamp?: number;
  urgent?: boolean;
  updatedPni?: string;
  story?: boolean;
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  const w = new ProtoWriter();
  w.writeUint32(1, env.type);
  w.writeString(2, env.sourceE164);
  w.writeUint32(7, env.sourceDevice);
  w.writeUint64(5, env.timestamp);
  w.writeBytes(6, env.legacyMessage);
  w.writeBytes(8, env.content);
  w.writeString(9, env.serverGuid);
  w.writeUint64(10, env.serverTimestamp);
  w.writeString(11, env.sourceUuid);
  w.writeString(13, env.destinationUuid);
  w.writeBool(14, env.urgent);
  return w.finish();
}

export function decodeEnvelope(buf: Uint8Array): Envelope {
  const r = new ProtoReader(buf);
  const out: Envelope = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.type = r.readUint32() as EnvelopeType; break;
      case 2: out.sourceE164 = r.readString(); break;
      case 5: out.timestamp = r.readVarintNumber(); break;
      case 6: out.legacyMessage = r.readBytes(); break;
      case 7: out.sourceDevice = r.readUint32(); break;
      case 8: out.content = r.readBytes(); break;
      case 9: out.serverGuid = r.readString(); break;
      case 10: out.serverTimestamp = r.readVarintNumber(); break;
      case 11: out.sourceUuid = r.readString(); break;
      case 13: out.destinationUuid = r.readString(); break;
      case 14: out.urgent = r.readBool(); break;
      case 15: out.updatedPni = r.readString(); break;
      case 16: out.story = r.readBool(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface AttachmentPointer {
  cdnId?: bigint;
  cdnKey?: string;
  contentType?: string;
  key?: Uint8Array;
  size?: number;
  thumbnail?: Uint8Array;
  digest?: Uint8Array;
  fileName?: string;
  flags?: number;
  width?: number;
  height?: number;
  caption?: string;
  blurHash?: string;
  uploadTimestamp?: number;
  cdnNumber?: number;
}

export function encodeAttachmentPointer(att: AttachmentPointer, w = new ProtoWriter()): void {
  if (att.cdnId !== undefined) w.writeFixed64(1, att.cdnId);
  w.writeString(2, att.contentType);
  w.writeBytes(3, att.key);
  w.writeUint32(4, att.size);
  w.writeBytes(5, att.thumbnail);
  w.writeBytes(6, att.digest);
  w.writeString(7, att.fileName);
  w.writeUint32(8, att.flags);
  w.writeUint32(9, att.width);
  w.writeUint32(10, att.height);
  w.writeString(11, att.caption);
  w.writeString(12, att.blurHash);
  w.writeUint64(13, att.uploadTimestamp);
  w.writeUint32(14, att.cdnNumber);
  w.writeString(15, att.cdnKey);
}

export function decodeAttachmentPointer(buf: Uint8Array): AttachmentPointer {
  const r = new ProtoReader(buf);
  const out: AttachmentPointer = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1:
        out.cdnId = wireType === WIRE_FIXED64 ? r.readFixed64Big() : r.readVarintBig();
        break;
      case 2: out.contentType = r.readString(); break;
      case 3: out.key = r.readBytes(); break;
      case 4: out.size = r.readUint32(); break;
      case 5: out.thumbnail = r.readBytes(); break;
      case 6: out.digest = r.readBytes(); break;
      case 7: out.fileName = r.readString(); break;
      case 8: out.flags = r.readUint32(); break;
      case 9: out.width = r.readUint32(); break;
      case 10: out.height = r.readUint32(); break;
      case 11: out.caption = r.readString(); break;
      case 12: out.blurHash = r.readString(); break;
      case 13: out.uploadTimestamp = r.readVarintNumber(); break;
      case 14: out.cdnNumber = r.readUint32(); break;
      case 15: out.cdnKey = r.readString(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface GroupContextV1 {
  id?: Uint8Array;
  type?: number;
  name?: string;
  membersE164?: string[];
  avatar?: AttachmentPointer;
}

export interface GroupContextV2 {
  masterKey?: Uint8Array;
  revision?: number;
  groupChange?: Uint8Array;
}

export interface QuoteProto {
  id?: number;
  authorE164?: string;
  authorUuid?: string;
  text?: string;
}

export interface ReactionProto {
  emoji?: string;
  remove?: boolean;
  targetAuthorE164?: string;
  targetAuthorUuid?: string;
  targetSentTimestamp?: number;
}

export interface DeleteProto {
  targetSentTimestamp?: number;
}

export enum BodyRangeStyle {
  NONE = 0,
  BOLD = 1,
  ITALIC = 2,
  SPOILER = 3,
  STRIKETHROUGH = 4,
  MONOSPACE = 5,
}

export interface BodyRangeProto {
  start?: number;
  length?: number;
  mentionUuid?: string;
  style?: BodyRangeStyle;
}

export interface StickerProto {
  packId?: Uint8Array;
  packKey?: Uint8Array;
  stickerId?: number;
  data?: AttachmentPointer;
  emoji?: string;
}

export interface DataMessage {
  body?: string;
  attachments?: AttachmentPointer[];
  groupV1?: GroupContextV1;
  groupV2?: GroupContextV2;
  flags?: number;
  expireTimer?: number;
  profileKey?: Uint8Array;
  timestamp?: number;
  quote?: QuoteProto;
  sticker?: StickerProto;
  reaction?: ReactionProto;
  delete?: DeleteProto;
  bodyRanges?: BodyRangeProto[];
  isViewOnce?: boolean;
}

export function encodeDataMessage(dm: DataMessage, w = new ProtoWriter()): Uint8Array {
  w.writeString(1, dm.body);
  for (const a of dm.attachments || []) {
    w.writeMessage(2, a, encodeAttachmentPointer);
  }
  if (dm.groupV1) {
    w.writeMessage(3, dm.groupV1, (g, gw) => {
      gw.writeBytes(1, g.id);
      gw.writeUint32(2, g.type);
      gw.writeString(3, g.name);
      for (const m of g.membersE164 || []) gw.writeString(4, m);
      if (g.avatar) gw.writeMessage(5, g.avatar, encodeAttachmentPointer);
    });
  }
  w.writeUint32(4, dm.flags);
  w.writeUint32(5, dm.expireTimer);
  w.writeBytes(6, dm.profileKey);
  w.writeUint64(7, dm.timestamp);
  if (dm.quote) {
    w.writeMessage(8, dm.quote, (q, qw) => {
      qw.writeUint64(1, q.id);
      qw.writeString(2, q.authorE164);
      qw.writeString(3, q.text);
      qw.writeString(5, q.authorUuid);
    });
  }
  if (dm.sticker) {
    w.writeMessage(10, dm.sticker, (st, sw) => {
      sw.writeBytes(1, st.packId);
      sw.writeBytes(2, st.packKey);
      sw.writeUint32(3, st.stickerId);
      if (st.data) sw.writeMessage(4, st.data, encodeAttachmentPointer);
      sw.writeString(5, st.emoji);
    });
  }
  if (dm.reaction) {
    w.writeMessage(11, dm.reaction, (rc, rw) => {
      rw.writeString(1, rc.emoji);
      rw.writeBool(2, rc.remove);
      rw.writeString(3, rc.targetAuthorE164);
      rw.writeUint64(4, rc.targetSentTimestamp);
      rw.writeString(5, rc.targetAuthorUuid);
    });
  }
  if (dm.delete) {
    w.writeMessage(13, dm.delete, (dl, dw) => {
      dw.writeUint64(1, dl.targetSentTimestamp);
    });
  }
  for (const br of dm.bodyRanges || []) {
    w.writeMessage(14, br, (b, bw) => {
      bw.writeUint32(1, b.start);
      bw.writeUint32(2, b.length);
      bw.writeString(3, b.mentionUuid);
      bw.writeUint32(4, b.style);
    });
  }
  if (dm.groupV2) {
    w.writeMessage(15, dm.groupV2, (g2, gw) => {
      gw.writeBytes(1, g2.masterKey);
      gw.writeUint32(2, g2.revision);
      gw.writeBytes(3, g2.groupChange);
    });
  }
  w.writeBool(16, dm.isViewOnce);
  return w.finish();
}

export function decodeDataMessage(buf: Uint8Array): DataMessage {
  const r = new ProtoReader(buf);
  const out: DataMessage = { attachments: [], bodyRanges: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.body = r.readString(); break;
      case 2: out.attachments!.push(decodeAttachmentPointer(r.readBytes())); break;
      case 3: {
        const gr = new ProtoReader(r.readBytes());
        const g1: GroupContextV1 = { membersE164: [] };
        while (!gr.eof()) {
          const gt = gr.readTag();
          switch (gt.fieldNumber) {
            case 1: g1.id = gr.readBytes(); break;
            case 2: g1.type = gr.readUint32(); break;
            case 3: g1.name = gr.readString(); break;
            case 4: g1.membersE164!.push(gr.readString()); break;
            case 5: g1.avatar = decodeAttachmentPointer(gr.readBytes()); break;
            default: gr.skipField(gt.wireType);
          }
        }
        out.groupV1 = g1;
        break;
      }
      case 4: out.flags = r.readUint32(); break;
      case 5: out.expireTimer = r.readUint32(); break;
      case 6: out.profileKey = r.readBytes(); break;
      case 7: out.timestamp = r.readVarintNumber(); break;
      case 8: {
        const qr = new ProtoReader(r.readBytes());
        const q: QuoteProto = {};
        while (!qr.eof()) {
          const qt = qr.readTag();
          switch (qt.fieldNumber) {
            case 1: q.id = qr.readVarintNumber(); break;
            case 2: q.authorE164 = qr.readString(); break;
            case 3: q.text = qr.readString(); break;
            case 5: q.authorUuid = qr.readString(); break;
            default: qr.skipField(qt.wireType);
          }
        }
        out.quote = q;
        break;
      }
      case 10: {
        const str = new ProtoReader(r.readBytes());
        const st: StickerProto = {};
        while (!str.eof()) {
          const stt = str.readTag();
          switch (stt.fieldNumber) {
            case 1: st.packId = str.readBytes(); break;
            case 2: st.packKey = str.readBytes(); break;
            case 3: st.stickerId = str.readUint32(); break;
            case 4: st.data = decodeAttachmentPointer(str.readBytes()); break;
            case 5: st.emoji = str.readString(); break;
            default: str.skipField(stt.wireType);
          }
        }
        out.sticker = st;
        break;
      }
      case 11: {
        const rr = new ProtoReader(r.readBytes());
        const rc: ReactionProto = {};
        while (!rr.eof()) {
          const rt = rr.readTag();
          switch (rt.fieldNumber) {
            case 1: rc.emoji = rr.readString(); break;
            case 2: rc.remove = rr.readBool(); break;
            case 3: rc.targetAuthorE164 = rr.readString(); break;
            case 4: rc.targetSentTimestamp = rr.readVarintNumber(); break;
            case 5: rc.targetAuthorUuid = rr.readString(); break;
            default: rr.skipField(rt.wireType);
          }
        }
        out.reaction = rc;
        break;
      }
      case 13: {
        const dr = new ProtoReader(r.readBytes());
        const dl: DeleteProto = {};
        while (!dr.eof()) {
          const dt = dr.readTag();
          if (dt.fieldNumber === 1) dl.targetSentTimestamp = dr.readVarintNumber();
          else dr.skipField(dt.wireType);
        }
        out.delete = dl;
        break;
      }
      case 14: {
        const brr = new ProtoReader(r.readBytes());
        const br: BodyRangeProto = {};
        while (!brr.eof()) {
          const bt = brr.readTag();
          switch (bt.fieldNumber) {
            case 1: br.start = brr.readUint32(); break;
            case 2: br.length = brr.readUint32(); break;
            case 3: br.mentionUuid = brr.readString(); break;
            case 4: br.style = brr.readUint32() as BodyRangeStyle; break;
            default: brr.skipField(bt.wireType);
          }
        }
        out.bodyRanges!.push(br);
        break;
      }
      case 15: {
        const g2r = new ProtoReader(r.readBytes());
        const g2: GroupContextV2 = {};
        while (!g2r.eof()) {
          const gt = g2r.readTag();
          switch (gt.fieldNumber) {
            case 1: g2.masterKey = g2r.readBytes(); break;
            case 2: g2.revision = g2r.readUint32(); break;
            case 3: g2.groupChange = g2r.readBytes(); break;
            default: g2r.skipField(gt.wireType);
          }
        }
        out.groupV2 = g2;
        break;
      }
      case 16: out.isViewOnce = r.readBool(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface EditMessageProto {
  targetSentTimestamp?: number;
  dataMessage?: DataMessage;
}

export function encodeEditMessage(em: EditMessageProto, w = new ProtoWriter()): Uint8Array {
  w.writeUint64(1, em.targetSentTimestamp);
  if (em.dataMessage) w.writeBytes(2, encodeDataMessage(em.dataMessage));
  return w.finish();
}

export function decodeEditMessage(buf: Uint8Array): EditMessageProto {
  const r = new ProtoReader(buf);
  const out: EditMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.targetSentTimestamp = r.readVarintNumber(); break;
      case 2: out.dataMessage = decodeDataMessage(r.readBytes()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export enum ReceiptType {
  DELIVERY = 0,
  READ = 1,
  VIEWED = 2,
}

export interface ReceiptMessageProto {
  type?: ReceiptType;
  timestamp: number[];
}

export function encodeReceiptMessage(rm: ReceiptMessageProto, w = new ProtoWriter()): Uint8Array {
  w.writeUint32(1, rm.type);
  for (const ts of rm.timestamp || []) w.writeUint64(2, ts);
  return w.finish();
}

export function decodeReceiptMessage(buf: Uint8Array): ReceiptMessageProto {
  const r = new ProtoReader(buf);
  const out: ReceiptMessageProto = { timestamp: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.type = r.readUint32() as ReceiptType; break;
      case 2:
        if (wireType === WIRE_BYTES) {
          const sub = new ProtoReader(r.readBytes());
          while (!sub.eof()) out.timestamp.push(sub.readVarintNumber());
        } else {
          out.timestamp.push(r.readVarintNumber());
        }
        break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export enum TypingAction {
  STARTED = 0,
  STOPPED = 1,
}

export interface TypingMessageProto {
  timestamp?: number;
  action?: TypingAction;
  groupId?: Uint8Array;
}

export function encodeTypingMessage(tm: TypingMessageProto, w = new ProtoWriter()): Uint8Array {
  w.writeUint64(1, tm.timestamp);
  w.writeUint32(2, tm.action);
  w.writeBytes(3, tm.groupId);
  return w.finish();
}

export function decodeTypingMessage(buf: Uint8Array): TypingMessageProto {
  const r = new ProtoReader(buf);
  const out: TypingMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.timestamp = r.readVarintNumber(); break;
      case 2: out.action = r.readUint32() as TypingAction; break;
      case 3: out.groupId = r.readBytes(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export enum SyncRequestType {
  UNKNOWN = 0,
  CONTACTS = 1,
  GROUPS = 2,
  BLOCKED = 3,
  CONFIGURATION = 4,
  KEYS = 5,
}

export enum VerifiedStateProto {
  DEFAULT = 0,
  VERIFIED = 1,
  UNVERIFIED = 2,
}

export interface VerifiedProto {
  destinationE164?: string;
  destinationUuid?: string;
  identityKey?: Uint8Array;
  state?: VerifiedStateProto;
}

export interface SyncBlockedProto {
  numbers: string[];
  uuids: string[];
  groupIds: Uint8Array[];
}

export interface SyncConfigurationProto {
  readReceipts?: boolean;
  unidentifiedDeliveryIndicators?: boolean;
  typingIndicators?: boolean;
  provisioningVersion?: number;
}

export enum FetchLatestType {
  UNKNOWN = 0,
  LOCAL_PROFILE = 1,
  STORAGE_MANIFEST = 2,
  SUBSCRIPTION_STATUS = 3,
}

export interface SyncSentProto {
  destinationE164?: string;
  destinationUuid?: string;
  timestamp?: number;
  message?: DataMessage;
  expirationStartTimestamp?: number;
  editMessage?: EditMessageProto;
}

export interface SyncReadProto {
  senderE164?: string;
  senderUuid?: string;
  timestamp?: number;
}

export interface SyncContactsProto {
  blob?: AttachmentPointer;
  complete?: boolean;
}

export interface SyncGroupsProto {
  blob?: AttachmentPointer;
}

export interface SyncMessageProto {
  sent?: SyncSentProto;
  contacts?: SyncContactsProto;
  groups?: SyncGroupsProto;
  request?: { type?: SyncRequestType };
  read?: SyncReadProto[];
  blocked?: SyncBlockedProto;
  verified?: VerifiedProto;
  configuration?: SyncConfigurationProto;
  fetchLatest?: { type?: FetchLatestType };
}

export function encodeSyncMessage(sm: SyncMessageProto, w = new ProtoWriter()): Uint8Array {
  if (sm.sent) {
    w.writeMessage(1, sm.sent, (s, sw) => {
      sw.writeString(1, s.destinationE164);
      sw.writeUint64(2, s.timestamp);
      if (s.message) sw.writeBytes(3, encodeDataMessage(s.message));
      sw.writeUint64(4, s.expirationStartTimestamp);
      sw.writeString(6, s.destinationUuid);
      if (s.editMessage) sw.writeBytes(9, encodeEditMessage(s.editMessage));
    });
  }
  if (sm.contacts) {
    w.writeMessage(2, sm.contacts, (c, cw) => {
      if (c.blob) cw.writeMessage(1, c.blob, encodeAttachmentPointer);
      cw.writeBool(2, c.complete);
    });
  }
  if (sm.groups) {
    w.writeMessage(3, sm.groups, (g, gw) => {
      if (g.blob) gw.writeMessage(1, g.blob, encodeAttachmentPointer);
    });
  }
  if (sm.request) {
    w.writeMessage(4, sm.request, (rq, rw) => {
      rw.writeUint32(1, rq.type);
    });
  }
  for (const rd of sm.read || []) {
    w.writeMessage(5, rd, (r, rw) => {
      rw.writeString(1, r.senderE164);
      rw.writeUint64(2, r.timestamp);
      rw.writeString(3, r.senderUuid);
    });
  }
  if (sm.blocked) {
    w.writeMessage(6, sm.blocked, (b, bw) => {
      for (const n of b.numbers || []) bw.writeString(1, n);
      for (const g of b.groupIds || []) bw.writeBytes(2, g);
      for (const u of b.uuids || []) bw.writeString(3, u);
    });
  }
  if (sm.verified) {
    w.writeMessage(7, sm.verified, (v, vw) => {
      vw.writeString(1, v.destinationE164);
      vw.writeBytes(2, v.identityKey);
      vw.writeUint32(3, v.state);
      vw.writeString(5, v.destinationUuid);
    });
  }
  if (sm.configuration) {
    w.writeMessage(8, sm.configuration, (cfg, cw) => {
      cw.writeBool(1, cfg.readReceipts);
      cw.writeBool(2, cfg.unidentifiedDeliveryIndicators);
      cw.writeBool(3, cfg.typingIndicators);
      cw.writeUint32(5, cfg.provisioningVersion);
    });
  }
  if (sm.fetchLatest) {
    w.writeMessage(11, sm.fetchLatest, (fl, fw) => {
      fw.writeUint32(1, fl.type);
    });
  }
  return w.finish();
}

export function decodeSyncMessage(buf: Uint8Array): SyncMessageProto {
  const r = new ProtoReader(buf);
  const out: SyncMessageProto = { read: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: {
        const sr = new ProtoReader(r.readBytes());
        const sent: SyncSentProto = {};
        while (!sr.eof()) {
          const st = sr.readTag();
          switch (st.fieldNumber) {
            case 1: sent.destinationE164 = sr.readString(); break;
            case 2: sent.timestamp = sr.readVarintNumber(); break;
            case 3: sent.message = decodeDataMessage(sr.readBytes()); break;
            case 4: sent.expirationStartTimestamp = sr.readVarintNumber(); break;
            case 6: sent.destinationUuid = sr.readString(); break;
            case 9: sent.editMessage = decodeEditMessage(sr.readBytes()); break;
            default: sr.skipField(st.wireType);
          }
        }
        out.sent = sent;
        break;
      }
      case 2: {
        const cr = new ProtoReader(r.readBytes());
        const contacts: SyncContactsProto = {};
        while (!cr.eof()) {
          const ct = cr.readTag();
          switch (ct.fieldNumber) {
            case 1: contacts.blob = decodeAttachmentPointer(cr.readBytes()); break;
            case 2: contacts.complete = cr.readBool(); break;
            default: cr.skipField(ct.wireType);
          }
        }
        out.contacts = contacts;
        break;
      }
      case 3: {
        const gr = new ProtoReader(r.readBytes());
        const groups: SyncGroupsProto = {};
        while (!gr.eof()) {
          const gt = gr.readTag();
          if (gt.fieldNumber === 1) groups.blob = decodeAttachmentPointer(gr.readBytes());
          else gr.skipField(gt.wireType);
        }
        out.groups = groups;
        break;
      }
      case 4: {
        const rqr = new ProtoReader(r.readBytes());
        let type = SyncRequestType.UNKNOWN;
        while (!rqr.eof()) {
          const rt = rqr.readTag();
          if (rt.fieldNumber === 1) type = rqr.readUint32() as SyncRequestType;
          else rqr.skipField(rt.wireType);
        }
        out.request = { type };
        break;
      }
      case 5: {
        const rdr = new ProtoReader(r.readBytes());
        const rd: SyncReadProto = {};
        while (!rdr.eof()) {
          const rt = rdr.readTag();
          switch (rt.fieldNumber) {
            case 1: rd.senderE164 = rdr.readString(); break;
            case 2: rd.timestamp = rdr.readVarintNumber(); break;
            case 3: rd.senderUuid = rdr.readString(); break;
            default: rdr.skipField(rt.wireType);
          }
        }
        out.read!.push(rd);
        break;
      }
      case 6: {
        const br = new ProtoReader(r.readBytes());
        const blocked: SyncBlockedProto = { numbers: [], uuids: [], groupIds: [] };
        while (!br.eof()) {
          const bt = br.readTag();
          if (bt.fieldNumber === 1) blocked.numbers.push(br.readString());
          else if (bt.fieldNumber === 2) blocked.groupIds.push(br.readBytes());
          else if (bt.fieldNumber === 3) blocked.uuids.push(br.readString());
          else br.skipField(bt.wireType);
        }
        out.blocked = blocked;
        break;
      }
      case 7: {
        const vr = new ProtoReader(r.readBytes());
        const verified: VerifiedProto = {};
        while (!vr.eof()) {
          const vt = vr.readTag();
          switch (vt.fieldNumber) {
            case 1: verified.destinationE164 = vr.readString(); break;
            case 2: verified.identityKey = vr.readBytes(); break;
            case 3: verified.state = vr.readUint32() as VerifiedStateProto; break;
            case 5: verified.destinationUuid = vr.readString(); break;
            default: vr.skipField(vt.wireType);
          }
        }
        out.verified = verified;
        break;
      }
      case 8: {
        const cfgr = new ProtoReader(r.readBytes());
        const cfg: SyncConfigurationProto = {};
        while (!cfgr.eof()) {
          const ct = cfgr.readTag();
          switch (ct.fieldNumber) {
            case 1: cfg.readReceipts = cfgr.readBool(); break;
            case 2: cfg.unidentifiedDeliveryIndicators = cfgr.readBool(); break;
            case 3: cfg.typingIndicators = cfgr.readBool(); break;
            case 5: cfg.provisioningVersion = cfgr.readUint32(); break;
            default: cfgr.skipField(ct.wireType);
          }
        }
        out.configuration = cfg;
        break;
      }
      case 11: {
        const flr = new ProtoReader(r.readBytes());
        let type = FetchLatestType.UNKNOWN;
        while (!flr.eof()) {
          const ft = flr.readTag();
          if (ft.fieldNumber === 1) type = flr.readUint32() as FetchLatestType;
          else flr.skipField(ft.wireType);
        }
        out.fetchLatest = { type };
        break;
      }
      default: r.skipField(wireType);
    }
  }
  return out;
}

export enum CallOfferType {
  OFFER_AUDIO_CALL = 0,
  OFFER_VIDEO_CALL = 1,
}

export interface CallMessageProto {
  offer?: {
    id?: bigint;
    type?: CallOfferType;
  };
  hangup?: {
    id?: bigint;
  };
  busy?: {
    id?: bigint;
  };
}

export function encodeCallMessage(cm: CallMessageProto, w = new ProtoWriter()): Uint8Array {
  if (cm.offer) {
    w.writeMessage(1, cm.offer, (of, ow) => {
      ow.writeUint64(1, of.id);
      ow.writeUint32(3, of.type);
    });
  }
  if (cm.hangup) {
    w.writeMessage(3, cm.hangup, (hu, hw) => {
      hw.writeUint64(1, hu.id);
    });
  }
  if (cm.busy) {
    w.writeMessage(4, cm.busy, (bs, bw) => {
      bw.writeUint64(1, bs.id);
    });
  }
  return w.finish();
}

export function decodeCallMessage(buf: Uint8Array): CallMessageProto {
  const r = new ProtoReader(buf);
  const out: CallMessageProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: {
        const or = new ProtoReader(r.readBytes());
        let id: bigint | undefined;
        let type = CallOfferType.OFFER_AUDIO_CALL;
        while (!or.eof()) {
          const ot = or.readTag();
          if (ot.fieldNumber === 1) id = or.readVarintBig();
          else if (ot.fieldNumber === 3) type = or.readUint32() as CallOfferType;
          else or.skipField(ot.wireType);
        }
        out.offer = { id, type };
        break;
      }
      case 3: {
        const hr = new ProtoReader(r.readBytes());
        let id: bigint | undefined;
        while (!hr.eof()) {
          const ht = hr.readTag();
          if (ht.fieldNumber === 1) id = hr.readVarintBig();
          else hr.skipField(ht.wireType);
        }
        out.hangup = { id };
        break;
      }
      case 4: {
        const br = new ProtoReader(r.readBytes());
        let id: bigint | undefined;
        while (!br.eof()) {
          const bt = br.readTag();
          if (bt.fieldNumber === 1) id = br.readVarintBig();
          else br.skipField(bt.wireType);
        }
        out.busy = { id };
        break;
      }
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface ContentProto {
  dataMessage?: DataMessage;
  syncMessage?: SyncMessageProto;
  callMessage?: CallMessageProto;
  receiptMessage?: ReceiptMessageProto;
  typingMessage?: TypingMessageProto;
  senderKeyDistributionMessage?: Uint8Array;
  editMessage?: EditMessageProto;
}

export function encodeContent(c: ContentProto): Uint8Array {
  const w = new ProtoWriter();
  if (c.dataMessage) w.writeBytes(1, encodeDataMessage(c.dataMessage));
  if (c.syncMessage) w.writeBytes(2, encodeSyncMessage(c.syncMessage));
  if (c.callMessage) w.writeBytes(3, encodeCallMessage(c.callMessage));
  if (c.receiptMessage) w.writeBytes(5, encodeReceiptMessage(c.receiptMessage));
  if (c.typingMessage) w.writeBytes(6, encodeTypingMessage(c.typingMessage));
  if (c.senderKeyDistributionMessage) w.writeBytes(7, c.senderKeyDistributionMessage);
  if (c.editMessage) w.writeBytes(9, encodeEditMessage(c.editMessage));
  return w.finish();
}

export function decodeContent(buf: Uint8Array): ContentProto {
  const r = new ProtoReader(buf);
  const out: ContentProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.dataMessage = decodeDataMessage(r.readBytes()); break;
      case 2: out.syncMessage = decodeSyncMessage(r.readBytes()); break;
      case 3: out.callMessage = decodeCallMessage(r.readBytes()); break;
      case 5: out.receiptMessage = decodeReceiptMessage(r.readBytes()); break;
      case 6: out.typingMessage = decodeTypingMessage(r.readBytes()); break;
      case 7: out.senderKeyDistributionMessage = r.readBytes(); break;
      case 9: out.editMessage = decodeEditMessage(r.readBytes()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

/* ============================================================================
 * 6. ContactDetails & GroupDetails (length-delimited sync blobs)
 * ============================================================================ */

export interface ContactDetailsProto {
  number?: string;
  uuid?: string;
  name?: string;
  avatar?: { contentType?: string; length?: number };
  color?: string;
  profileKey?: Uint8Array;
  blocked?: boolean;
  expireTimer?: number;
}

export function decodeContactDetails(buf: Uint8Array): ContactDetailsProto {
  const r = new ProtoReader(buf);
  const out: ContactDetailsProto = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.number = r.readString(); break;
      case 2: out.name = r.readString(); break;
      case 3: {
        const ar = new ProtoReader(r.readBytes());
        const av: { contentType?: string; length?: number } = {};
        while (!ar.eof()) {
          const at = ar.readTag();
          if (at.fieldNumber === 1) av.contentType = ar.readString();
          else if (at.fieldNumber === 2) av.length = ar.readUint32();
          else ar.skipField(at.wireType);
        }
        out.avatar = av;
        break;
      }
      case 4: out.color = r.readString(); break;
      case 6: out.profileKey = r.readBytes(); break;
      case 7: out.blocked = r.readBool(); break;
      case 8: out.expireTimer = r.readUint32(); break;
      case 9: out.uuid = r.readString(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export interface GroupDetailsProto {
  id?: Uint8Array;
  name?: string;
  membersE164: string[];
  avatar?: { contentType?: string; length?: number };
  active?: boolean;
  expireTimer?: number;
  blocked?: boolean;
}

export function decodeGroupDetails(buf: Uint8Array): GroupDetailsProto {
  const r = new ProtoReader(buf);
  const out: GroupDetailsProto = { membersE164: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.id = r.readBytes(); break;
      case 2: out.name = r.readString(); break;
      case 3: out.membersE164.push(r.readString()); break;
      case 4: {
        const ar = new ProtoReader(r.readBytes());
        const av: { contentType?: string; length?: number } = {};
        while (!ar.eof()) {
          const at = ar.readTag();
          if (at.fieldNumber === 1) av.contentType = ar.readString();
          else if (at.fieldNumber === 2) av.length = ar.readUint32();
          else ar.skipField(at.wireType);
        }
        out.avatar = av;
        break;
      }
      case 5: out.active = r.readBool(); break;
      case 6: out.expireTimer = r.readUint32(); break;
      case 8: out.blocked = r.readBool(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}
