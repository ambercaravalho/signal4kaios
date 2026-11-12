import { router } from '../../app/router';
import type { GroupDetail } from '../../data/api';
import { fmtBytes } from '../../data/format';
import { openUrl } from '../../data/platform';
import * as store from '../../data/store';
import { extractUrls } from '../../data/styled';
import type { Attachment, Conversation, Message } from '../../data/types';
import { friendlyError, sendError } from '../../errors';
import { openChat } from '../../screens/Chat';
import { ForwardScreen } from '../../screens/Forward';
import { MessageDetailsScreen, PollVotesScreen } from '../../screens/MessageDetails';
import { openSignalLink } from '../../screens/open-link';
import { SafetyNumberScreen } from '../../screens/SafetyNumber';
import { ViewerScreen } from '../../screens/Viewer';
import { fmt, S } from '../../strings';
import { pickReaction } from '../Emoji';
import { confirm, DIVIDER, type MenuEntry, pick, pickMany, showOptions } from '../Overlays';
import { toast } from '../Toast';
import { authorName } from './Bubble';
import { cardContact } from './ContactCardView';

/** Signal allows edits and delete-for-everyone for 24 hours. */
const CHANGE_WINDOW_MS = 24 * 3600 * 1000;

export function attachmentAction(att: Attachment): string {
  const t = att.contentType || '';
  if (att.viewOnce) return S.viewOnceMedia;
  if (t.indexOf('image/') === 0) return S.viewPhoto;
  if (att.voiceNote || t.indexOf('audio/') === 0) return S.playVoice;
  if (t.indexOf('video/') === 0) return S.playVideo;
  return S.openFile;
}

export type MainAction = 'retry' | 'attachment' | 'vote' | 'card' | 'readFull' | 'openLink';

/** What someone most likely wants from a message, in the order its options menu leads with them. */
export function mainActions(m: Message, clipped: boolean): MainAction[] {
  if (m.deleted) return m.status === 'failed' ? ['retry'] : [];
  const out: MainAction[] = [];
  if (m.status === 'failed') out.push('retry');
  if (m.attachments[0]) out.push('attachment');
  if (m.poll && !m.poll.ended && m.status !== 'failed' && m.status !== 'pending') out.push('vote');
  if (m.contactCard) out.push('card');
  if (clipped) out.push('readFull');
  if (extractUrls(m.body).length) out.push('openLink');
  return out;
}

function canForward(m: Message): boolean {
  const att = m.attachments[0];
  return !m.deleted && !m.notice && !m.contactCard && m.attachments.length <= 1 && (!!m.body || !!att) && (!att || (!!att.id && !att.viewOnce));
}

function canChange(m: Message): boolean {
  return !m.incoming && !m.deleted && (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') && Date.now() - m.timestamp < CHANGE_WINDOW_MS;
}

function canAdminDelete(m: Message, group: GroupDetail | null): boolean {
  return m.incoming && !m.deleted && !m.notice && !!group && (group.admins || []).some(store.isSelf) && Date.now() - m.timestamp < store.ADMIN_DELETE_MAX_AGE;
}

/** What the options menu needs from the open chat. */
export interface MessageOptionsContext {
  conv: Conversation | undefined;
  request: boolean;
  group: GroupDetail | null;
  /** The message's text overflows its bubble. */
  clipped: boolean;
  reply(m: Message): void;
  edit(m: Message): void;
  insertText(text: string): void;
}

function openAttachment(m: Message, att: Attachment): void {
  router.push(ViewerScreen, { att, msg: m, title: authorName(m), onOpened: () => store.markViewed(m) });
}

async function pickAttachment(m: Message): Promise<void> {
  const i = await pick(
    S.viewAttachments,
    m.attachments.map((a, n) => ({ value: n, label: a.filename || store.attachmentLabel([a]), sub: a.size ? fmtBytes(a.size) : undefined })),
    -1
  );
  if (i !== undefined && i >= 0) openAttachment(m, m.attachments[i]);
}

async function react(m: Message): Promise<void> {
  const mine = (m.reactions || {})[store.selfNumber()] || null;
  const emoji = await pickReaction(mine);
  if (emoji === undefined) return;
  store.reactTo(m, emoji).catch((e) => toast(sendError(e)));
}

async function openLinks(urls: string[]): Promise<void> {
  const url = urls.length === 1 ? urls[0] : await pick(S.openLink, urls.map((u) => ({ value: u, label: u })), '');
  if (url && !openSignalLink(url)) openUrl(url).catch(() => toast(S.errGeneric));
}

/** Copies to the clipboard where KaiOS has one; otherwise the text goes into the composer. */
function copyText(text: string, insertText: (text: string) => void): void {
  const clip = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
  const fallback = () => {
    insertText(text);
  };
  if (clip && clip.writeText) clip.writeText(text).then(() => toast(S.copied), fallback);
  else fallback();
}

function deleteForMeItem(m: Message) {
  return {
    label: S.deleteForMe,
    onSelect: async () => {
      if (await confirm({ title: S.deleteForMeTitle, body: S.deleteForMeBody, ok: S.delete, danger: true })) store.deleteLocal(m);
    },
  };
}

function noticeOptions(m: Message): void {
  const n = m.notice!;
  showOptions([
    n.kind === 'safetyNumber' && { label: S.viewSafetyNumber, onSelect: () => router.push(SafetyNumberScreen, { target: m.author, name: store.displayName(m.author) }) },
    DIVIDER,
    deleteForMeItem(m),
  ]);
}

function contactCardOptions(m: Message, insertText: (text: string) => void) {
  const card = !m.deleted && m.contactCard;
  if (!card) return [];
  const known = cardContact(card);
  if (known) return [{ label: fmt(S.messageName, { name: card.name || store.displayName(known.id) }), onSelect: () => openChat(store.conversationWith(known).id) }];
  return card.phones.length ? [{ label: S.copyNumber, onSelect: () => copyText(card.phones[0], insertText) }] : [];
}

async function vote(m: Message): Promise<void> {
  const p = m.poll!;
  const mine = p.votes[store.selfNumber()];
  const current = mine ? mine.options : [];
  const choices = p.options.map((o, i) => ({ value: i, label: o }));
  let chosen: number[] | undefined;
  if (p.allowMultiple) chosen = await pickMany(S.vote, choices, current);
  else {
    const i = await pick(S.vote, current.length ? choices.concat({ value: -1, label: S.removeVote }) : choices, current.length ? current[0] : -1);
    chosen = i === undefined ? undefined : i < 0 ? [] : [i];
  }
  if (!chosen) return;
  const next = chosen.slice().sort((a, b) => a - b);
  if (next.join() === current.slice().sort((a, b) => a - b).join()) return;
  store.votePoll(m, next).catch((e) => toast(sendError(e)));
}

async function endPoll(m: Message): Promise<void> {
  if (!(await confirm({ title: S.endPoll, body: S.endPollBody, ok: S.endPoll, danger: true }))) return;
  store.endPoll(m).catch((e) => toast(sendError(e)));
}

/** The options menu for one message, led by what it's most likely opened for. */
export function messageOptions(m: Message, ctx: MessageOptionsContext): void {
  if (m.notice) return noticeOptions(m);
  const { conv, request } = ctx;
  const urls = m.deleted ? [] : extractUrls(m.body);
  const att = m.attachments[0];
  const settled = m.status !== 'failed' && m.status !== 'pending' && !request;
  const main: Record<MainAction, MenuEntry[]> = {
    retry: [{ label: S.retry, onSelect: () => store.retryMessage(m).catch((e) => toast(sendError(e))) }],
    attachment: m.attachments.length > 1 ? [{ label: S.viewAttachments, onSelect: () => pickAttachment(m) }] : [att && { label: attachmentAction(att), onSelect: () => openAttachment(m, att) }],
    vote: [!!conv && conv.type === 'group' && !request && { label: S.vote, onSelect: () => vote(m) }],
    card: contactCardOptions(m, ctx.insertText),
    readFull: [{ label: S.readFull, onSelect: () => router.push(MessageDetailsScreen, { msg: m }) }],
    openLink: [{ label: S.openLink, onSelect: () => openLinks(urls) }],
  };
  const lead = mainActions(m, ctx.clipped);
  showOptions([
    ...lead.reduce<MenuEntry[]>((acc, k) => acc.concat(main[k]), []),
    DIVIDER,
    !m.deleted && settled && { label: S.react, onSelect: () => react(m) },
    !m.deleted && settled && { label: S.reply, onSelect: () => ctx.reply(m) },
    DIVIDER,
    !m.deleted && !!m.body && { label: S.copyText, onSelect: () => copyText(m.body, ctx.insertText) },
    settled && canForward(m) && { label: S.forward, onSelect: () => router.push(ForwardScreen, { msg: m }) },
    canChange(m) && !m.attachments.length && !m.poll && (m.history || []).length < store.MAX_EDITS && { label: S.edit, onSelect: () => ctx.edit(m) },
    !m.deleted && !!m.poll && { label: S.viewVotes, onSelect: () => router.push(PollVotesScreen, { msg: m }) },
    !m.deleted && settled && !m.incoming && !!m.poll && !m.poll.ended && { label: S.endPoll, onSelect: () => endPoll(m) },
    DIVIDER,
    !m.deleted && settled && { label: m.pinned ? S.unpinMessage : S.pinMessage, onSelect: () => store.setMessagePinned(m, !m.pinned).catch((e) => toast(sendError(e))) },
    { label: S.messageDetails, onSelect: () => router.push(MessageDetailsScreen, { msg: m }) },
    DIVIDER,
    deleteForMeItem(m),
    canChange(m) && {
      label: S.deleteForEveryone,
      danger: true,
      onSelect: async () => {
        if (await confirm({ title: S.deleteForEveryone, body: S.deleteForEveryoneBody, ok: S.delete, danger: true })) store.deleteForEveryone(m).catch((e) => toast(friendlyError(e)));
      },
    },
    canAdminDelete(m, ctx.group) && {
      label: S.deleteForEveryone,
      danger: true,
      onSelect: async () => {
        if (await confirm({ title: S.deleteForEveryone, body: S.adminDeleteBody, ok: S.delete, danger: true })) store.adminDelete(m).catch((e) => toast(friendlyError(e)));
      },
    },
  ]);
}
