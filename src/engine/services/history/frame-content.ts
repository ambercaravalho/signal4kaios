/* A link-and-sync archive's message contents to the data message JSON the app's normalizer reads, following Signal-Desktop's backups/import. Every field comes from the archive, so lengths are capped here and shapes are checked again by the normalizer. */

import { bytesToUuid } from '../../bytes';
import {
  BodyRange_Style,
  type ContactAttachment,
  type FilePointer,
  type LinkPreview,
  MessageAttachment_Flag,
  type Quote,
  type StandardMessage,
  type Text,
} from '../../gen/Backups_pb';
import { encodeAttachmentDescriptor } from '../../net/attachment-descriptor';

const MAX_ATTACHMENTS = 32;
const MAX_RANGES = 250;
const MAX_CARD_FIELDS = 5;
const MAX_WAVEFORM = 100;

/** Who a recipient ID in the archive names: a person's key (number, else ACI) and ACI. */
export interface RecipientLookup {
  keyOf(id: bigint): string | null;
  aciOf(id: bigint): string;
}

export function uuidOf(b: Uint8Array | undefined): string {
  return b && b.length === 16 ? bytesToUuid(b) : '';
}

function styleName(s: BodyRange_Style): string | null {
  switch (s) {
    case BodyRange_Style.BOLD: return 'BOLD';
    case BodyRange_Style.ITALIC: return 'ITALIC';
    case BodyRange_Style.SPOILER: return 'SPOILER';
    case BodyRange_Style.STRIKETHROUGH: return 'STRIKETHROUGH';
    case BodyRange_Style.MONOSPACE: return 'MONOSPACE';
    default: return null;
  }
}

/** The text of a message, with its mentions and styles, into `dm`. */
export function textInto(text: Text | undefined, dm: any): void {
  if (!text) return;
  dm.message = text.body;
  const mentions: any[] = [];
  const styles: any[] = [];
  for (const r of text.bodyRanges.slice(0, MAX_RANGES)) {
    const v = r.associatedValue;
    if (v.case === 'mentionAci' && uuidOf(v.value)) mentions.push({ start: r.start, length: r.length, uuid: uuidOf(v.value) });
    else if (v.case === 'style' && styleName(v.value)) styles.push({ start: r.start, length: r.length, style: styleName(v.value) });
  }
  if (mentions.length) dm.mentions = mentions;
  if (styles.length) dm.textStyles = styles;
}

/** An attachment as the normalizer reads it. Its ID is empty when the archive names no CDN copy (older than the transit tier keeps), so opening it asks the phone for it. */
export function attachmentJson(ptr: FilePointer | undefined, voiceNote: boolean, viewOnce: boolean): any | null {
  if (!ptr) return null;
  const loc = ptr.locatorInfo;
  const contentType = ptr.contentType || 'application/octet-stream';
  const fileName = ptr.fileName || '';
  let id = '';
  if (loc && loc.key.length === 64 && loc.transitCdnKey) {
    const ic = loc.integrityCheck;
    id = encodeAttachmentDescriptor({
      cdnKey: loc.transitCdnKey,
      cdnNumber: loc.transitCdnNumber || 0,
      key: loc.key,
      digest: ic.case === 'encryptedDigest' ? ic.value : undefined,
      plaintextHash: ic.case === 'plaintextHash' ? ic.value : undefined,
      contentType,
      fileName,
      size: loc.size,
    });
  }
  const out: any = { id, contentType, filename: fileName, size: loc ? loc.size : 0, voiceNote, viewOnce };
  if (ptr.width && ptr.height) {
    out.width = ptr.width;
    out.height = ptr.height;
  }
  if (ptr.blurHash) out.blurHash = ptr.blurHash;
  if (ptr.audioWaveform && ptr.audioWaveform.length) out.waveform = Array.from(ptr.audioWaveform.subarray(0, MAX_WAVEFORM));
  if (ptr.audioDurationSeconds) out.duration = ptr.audioDurationSeconds;
  return out;
}

function quoteJson(q: Quote, people: RecipientLookup): any {
  return {
    id: Number(q.targetSentTimestamp || 0n),
    authorNumber: people.keyOf(q.authorId) || '',
    text: q.text ? q.text.body : '',
    attachments: q.attachments.slice(0, 10).map((a) => ({ contentType: a.contentType || '', filename: a.fileName || '' })),
  };
}

function previewJson(p: LinkPreview): any {
  const image = p.image && (p.image.contentType || '').indexOf('image/') === 0 ? attachmentJson(p.image, false, false) : null;
  return { url: p.url, title: p.title || '', description: p.description || '', image: image && image.id ? image : undefined };
}

export function contactCardJson(c: ContactAttachment): any {
  const n = c.name;
  const name = n ? n.nickname || [n.prefix, n.givenName, n.middleName, n.familyName, n.suffix].filter(Boolean).join(' ') : '';
  return {
    name: name || c.organization || '',
    phones: c.number.map((p) => p.value).filter(Boolean).slice(0, MAX_CARD_FIELDS),
    emails: c.email.map((e) => e.value).filter(Boolean).slice(0, MAX_CARD_FIELDS),
  };
}

export function standardJson(m: StandardMessage, people: RecipientLookup): any {
  const dm: any = {};
  textInto(m.text, dm);
  const attachments = m.attachments.slice(0, MAX_ATTACHMENTS).map((a) => attachmentJson(a.pointer, a.flag === MessageAttachment_Flag.VOICE_MESSAGE, false)).filter(Boolean);
  if (attachments.length) dm.attachments = attachments;
  if (m.quote) dm.quote = quoteJson(m.quote, people);
  if (m.linkPreview.length) dm.preview = previewJson(m.linkPreview[0]);
  return dm;
}

/** Reactions keyed by the reactor, as stored messages keep them. */
export function reactionsOf(list: Array<{ emoji: string; authorId: bigint }>, people: RecipientLookup): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of list.slice(0, 100)) {
    const key = people.keyOf(r.authorId);
    if (key && r.emoji) out[key] = r.emoji.slice(0, 16);
  }
  return out;
}
