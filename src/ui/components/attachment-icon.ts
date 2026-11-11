import type { Attachment } from '../data/types';

/** The `Icon` name for an attachment's kind. */
export function attachmentIcon(att: Pick<Attachment, 'contentType'> & Partial<Attachment>): string {
  const t = att.contentType || '';
  if (att.voiceNote || t.indexOf('audio/') === 0) return 'mic';
  if (t.indexOf('video/') === 0) return 'play';
  if (t.indexOf('image/') === 0) return 'photo';
  return 'file';
}
