/* The text a message or notice shows in the chat list and notifications. */

import { fmt, plural, S } from '../../strings';
import { config } from '../config';
import { groupUpdateText, type LineNames, timerText } from '../group-lines';
import type { Attachment, Message, Notice } from '../types';
import { displayName, isSelfKey } from './contacts';

/** The chat-list preview for a message with no text. */
export function attachmentLabel(attachments: Array<Partial<Attachment>> | undefined): string {
  if (!attachments || !attachments.length) return '';
  const a = attachments[0];
  const type = a.contentType || '';
  if (attachments.length > 1) {
    const photos = attachments.every((x) => (x.contentType || '').indexOf('image/') === 0);
    return photos ? plural(attachments.length, S.photoOne, S.photoMany) : plural(attachments.length, S.attachmentOne, S.attachmentMany);
  }
  if (a.viewOnce) return 'View-once media';
  if (a.voiceNote || type.indexOf('audio/') === 0) return 'Voice message';
  if (type.indexOf('image/') === 0) return 'Photo';
  if (type.indexOf('video/') === 0) return 'Video';
  return a.filename || 'File';
}

export function previewOf(rec: Pick<Message, 'body' | 'attachments' | 'contactCard' | 'poll'>): string {
  if (rec.poll) return fmt(S.pollPreview, { question: rec.poll.question });
  return rec.body || attachmentLabel(rec.attachments) || (rec.contactCard ? S.sharedContact : '');
}

/** What a notice line says; `author` is who it's about. */
export function noticeText(notice: Notice, author: string): string {
  switch (notice.kind) {
    case 'missedCall':
      return notice.video ? S.missedVideoCall : S.missedVoiceCall;
    case 'safetyNumber':
      return fmt(S.safetyNumberChanged, { name: displayName(author) });
    case 'groupCall':
      return author && !isSelfKey(author) ? fmt(S.startedGroupCall, { name: displayName(author) }) : S.groupCall;
    case 'pollEnded':
      return isSelfKey(author) || author === config.aci() ? fmt(S.youEndedPoll, { question: notice.text || '' }) : fmt(S.endedPoll, { name: displayName(author), question: notice.text || '' });
    case 'timer':
      return timerText(notice.seconds || 0, author, lineNames);
    case 'groupUpdate':
      return groupUpdateText(notice, author, lineNames);
    case 'payment':
      return paymentText(notice.value, author);
    case 'storyReaction':
      return fmt(lineNames.isMe(author) ? S.storyReactionSent : S.storyReaction, { name: displayName(author), emoji: notice.text || '' });
  }
}

function paymentText(kind: string | undefined, author: string): string {
  const me = lineNames.isMe(author);
  const name = displayName(author);
  if (kind === 'activationRequest') return me ? S.paymentActivationRequestSent : fmt(S.paymentActivationRequest, { name });
  if (kind === 'activated') return me ? S.paymentActivatedYou : fmt(S.paymentActivated, { name });
  return me ? S.paymentSent : fmt(S.paymentReceived, { name });
}

const lineNames: LineNames = {
  name: (key) => displayName(key),
  isMe: (key) => isSelfKey(key) || (!!config.aci() && key === config.aci()),
};

export function messageText(rec: Message): string {
  return rec.notice ? noticeText(rec.notice, rec.author) : previewOf(rec);
}
