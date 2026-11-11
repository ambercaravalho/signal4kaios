/* Sending messages: text, attachments, edits, forwards, and retries. */

import { isValidLinkPreview } from '../../../engine/services/link-previews';
import { signal } from '../api';
import { config } from '../config';
import { db } from '../db';
import { type FetchedPreview, imageDataUri } from '../link-preview-fetch';
import { dbg } from '../log';
import { encodeMentions, parseStyledMarkdown, type PickedMention, type StyleRange } from '../styled';
import type { Attachment, Conversation, Message, Quote } from '../types';
import { unarchiveOnActivity } from './chat-state';
import { isSelfConv, self } from './contacts';
import { msgId, persistConv, setConvExpire } from './conversations';
import { emit } from './events';
import { keepVersion, setPreviewIfLast } from './ingest';
import { sendPoll } from './polls';
import { attachmentLabel, previewOf } from './previews';
import { convs } from './state';

export type SendPayload = Parameters<typeof signal.send>[0];
type SendMeta = NonNullable<NonNullable<SendPayload['attachment_meta']>[number]>;

export function basePayload(conv: Conversation, message: string): SendPayload {
  return { recipients: [conv.sendId!], message, expire_timer: conv.expireTimer || 0 };
}

export function sendCore(conv: Conversation, rec: Message, payload: SendPayload, preview: string): Promise<Message> {
  db.putMessage(rec);
  conv.lastTs = rec.timestamp;
  conv.lastPreview = preview;
  unarchiveOnActivity(conv);
  persistConv(conv);
  emit('message', rec);
  emit('conversations');

  const ts = rec.timestamp;
  return signal.send(payload).then(
    (res: any) => {
      const newTs = res && res.timestamp ? parseInt(res.timestamp, 10) : ts;
      const oldId = rec.id;
      if (newTs && newTs !== ts) {
        db.deleteMessage(oldId);
        rec.timestamp = newTs;
        rec.id = msgId(conv.id, newTs, self());
        conv.lastTs = Math.max(conv.lastTs, newTs);
        persistConv(conv);
      }
      rec.status = 'sent';
      if (res && res.sealed) rec.sealed = true;
      db.putMessage(rec);
      emit('message-updated', rec, oldId);
      return rec;
    },
    (err: any) => {
      rec.status = 'failed';
      db.putMessage(rec);
      emit('message-updated', rec, undefined);
      dbg('send failed: ' + (err && err.message));
      throw err;
    }
  );
}

export function newOutgoingRec(conv: Conversation, extras: Partial<Message>): Message {
  const ts = Date.now();
  const base: Message = {
    id: msgId(conv.id, ts, self()),
    convId: conv.id,
    incoming: false,
    author: self(),
    authorName: '',
    timestamp: ts,
    body: '',
    styles: [],
    quote: null,
    attachments: [],
    reactions: {},
    status: 'pending',
    deleted: false,
    edited: false,
  };
  if (conv.expireTimer) {
    base.expireSecs = conv.expireTimer;
    base.expiresAt = ts + conv.expireTimer * 1000;
  }
  return Object.assign(base, extras);
}

export function convForSend(convId: string): Conversation {
  const conv = convs[convId];
  if (!conv) throw new Error('unknown chat');
  if (!conv.sendId) throw new Error('group not ready');
  return conv;
}

/** Signal-Desktop's universal timer: our first message in a 1:1 chat with no history and no timer starts the account's default timer first. */
function withDefaultTimer(conv: Conversation, send: () => Promise<Message>): Promise<Message> {
  const secs = config.defaultExpireTimer();
  if (!secs || conv.type !== 'direct' || conv.expireTimer || conv.lastTs > 0 || isSelfConv(conv) || !conv.sendId) return send();
  return signal
    .setDirectExpireTimer(conv.sendId, secs)
    .then(
      () => setConvExpire(conv.id, secs),
      (e) => dbg('default timer failed: ' + (e && e.message))
    )
    .then(send);
}

/** With styled text on, typed markers become formatting locally and in what's sent. */
function styled(text: string): { body: string; styles: StyleRange[] } {
  if (config.styledText() && text) return parseStyledMarkdown(text);
  return { body: text || '', styles: [] };
}

export function sendText(convId: string, text: string, quote?: Quote | null, mentions: PickedMention[] = [], preview?: FetchedPreview | null): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(convId);
  } catch (e) {
    return Promise.reject(e);
  }
  return withDefaultTimer(conv, () => {
    const st = styled(text);
    const wire = encodeMentions(st.body, st.styles, mentions);
    const rec = newOutgoingRec(conv, { body: st.body, styles: st.styles, raw: text, quote: quote || null });
    if (wire.mentions.length) rec.mentions = mentions;
    const payload: SendPayload = { ...basePayload(conv, wire.body), styles: wire.styles, mentions: wire.mentions };
    addQuote(payload, quote);
    if (preview && isValidLinkPreview(preview.url, wire.body)) {
      payload.preview = { url: preview.url, title: preview.title, description: preview.description, date: preview.date, image: preview.image ? imageDataUri(preview.image) : undefined };
      rec.preview = { url: preview.url, title: preview.title, description: preview.description };
    }
    return sendCore(conv, rec, payload, st.body);
  });
}

function addQuote(payload: SendPayload, quote: Quote | null | undefined): void {
  if (!quote) return;
  payload.quote_timestamp = quote.timestamp;
  payload.quote_author = quote.author;
  payload.quote_message = quote.text;
  if (quote.attachments && quote.attachments.length) payload.quote_attachments = quote.attachments;
}

/** Signal-Desktop's composer takes up to 32 attachments per message. */
export const MAX_ATTACHMENTS = 32;

/** A file to send; `dataUri` is "data:<mime>;base64,…" (a scaled photo, a picked file, or a voice note). */
export interface OutgoingFile {
  dataUri: string;
  contentType?: string;
  filename?: string;
  size?: number;
  voiceNote?: boolean;
  waveform?: number[];
  duration?: number;
  blurHash?: string;
  width?: number;
  height?: number;
}

type AttachmentExtras = Pick<Attachment, 'voiceNote' | 'waveform' | 'duration' | 'blurHash' | 'width' | 'height'>;

function outgoingMeta(f: AttachmentExtras): SendMeta | null {
  if (!f.voiceNote && !f.waveform && !f.duration && !f.blurHash && !f.width) return null;
  const meta: SendMeta = {};
  if (f.voiceNote) meta.voice = true;
  if (f.waveform) meta.waveform = f.waveform;
  if (f.duration) meta.duration = f.duration;
  if (f.blurHash) meta.blurHash = f.blurHash;
  if (f.width && f.height) {
    meta.width = f.width;
    meta.height = f.height;
  }
  return meta;
}

function localAttachment(f: OutgoingFile): Attachment {
  const att: Attachment = { id: '', contentType: f.contentType || 'image/jpeg', filename: f.filename == null ? 'photo.jpg' : f.filename, size: f.size || 0, voiceNote: !!f.voiceNote };
  if (f.waveform && f.waveform.length) att.waveform = f.waveform;
  if (f.duration) att.duration = f.duration;
  if (f.blurHash) att.blurHash = f.blurHash;
  if (f.width && f.height) {
    att.width = f.width;
    att.height = f.height;
  }
  return att;
}

/** One message carrying `files` in order, with `caption` as its text. View-once media goes alone and without a caption, as in Signal. */
export function sendAttachments(convId: string, files: OutgoingFile[], caption: string, opts: { viewOnce?: boolean; quote?: Quote | null } = {}): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(convId);
    if (!files.length || files.length > MAX_ATTACHMENTS || (opts.viewOnce && files.length > 1)) throw new Error('Too many attachments');
  } catch (e) {
    return Promise.reject(e);
  }
  const atts: Attachment[] = files.map((f) => {
    const att = localAttachment(f);
    if (opts.viewOnce) att.viewOnce = true;
    return att;
  });
  const text = opts.viewOnce ? '' : caption || '';
  return withDefaultTimer(conv, () => {
    const st = styled(text);
    const rec = newOutgoingRec(conv, { body: st.body, styles: st.styles, raw: text, attachments: atts, quote: opts.quote || null });
    const payload: SendPayload = { ...basePayload(conv, st.body), styles: st.styles, base64_attachments: files.map((f) => f.dataUri) };
    const meta = files.map(outgoingMeta);
    if (meta.some(Boolean)) payload.attachment_meta = meta;
    if (opts.viewOnce) payload.view_once = true;
    addQuote(payload, opts.quote);
    return sendCore(conv, rec, payload, st.body || attachmentLabel(atts));
  });
}

export function sendEdit(rec: Message, newText: string, mentions: PickedMention[] = []): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(rec.convId);
  } catch (e) {
    return Promise.reject(e);
  }
  const st = styled(newText);
  const wire = encodeMentions(st.body, st.styles, mentions);
  return signal.send({ ...basePayload(conv, wire.body), styles: wire.styles, mentions: wire.mentions, edit_timestamp: rec.timestamp }).then((res) => {
    keepVersion(rec);
    rec.editedAt = (res && res.timestamp) || Date.now();
    rec.body = st.body;
    rec.styles = st.styles;
    rec.raw = newText;
    rec.mentions = wire.mentions.length ? mentions : undefined;
    rec.edited = true;
    db.putMessage(rec);
    emit('message-updated', rec, undefined);
    setPreviewIfLast(conv.id, rec, st.body);
    return rec;
  });
}

/** A copy of `m` in another chat. Text keeps its formatting but not its mentions; `dataUri` carries the attachment's bytes when it has one. */
export function forwardMessage(convId: string, m: Message, dataUri?: string): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(convId);
  } catch (e) {
    return Promise.reject(e);
  }
  const src = dataUri ? m.attachments[0] : undefined;
  const attachments: Attachment[] = src ? [localAttachment({ dataUri: '', contentType: src.contentType, filename: src.filename, size: src.size, voiceNote: src.voiceNote, waveform: src.waveform, duration: src.duration, blurHash: src.blurHash, width: src.width, height: src.height })] : [];
  return withDefaultTimer(conv, () => {
    const rec = newOutgoingRec(conv, { body: m.body, styles: m.styles || [], attachments });
    const payload: SendPayload = { ...basePayload(conv, m.body), styles: m.styles || [] };
    if (dataUri) payload.base64_attachments = [dataUri];
    const meta = src && outgoingMeta(src);
    if (meta) payload.attachment_meta = [meta];
    return sendCore(conv, rec, payload, previewOf(rec));
  });
}

export function retryMessage(rec: Message): Promise<Message> {
  db.deleteMessage(rec.id);
  emit('message-removed', { id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
  if (rec.poll) return sendPoll(rec.convId, rec.poll.question, rec.poll.options, rec.poll.allowMultiple);
  return sendText(rec.convId, rec.raw != null ? rec.raw : rec.body, rec.quote, rec.mentions || []);
}
