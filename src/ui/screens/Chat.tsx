import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useFocusScroll } from '../app/focus';
import { useObjectUrl, useStoreEvent, useStoreEvents } from '../app/hooks';
import { attachmentIcon } from '../components/attachment-icon';
import { router, useIsTop, useKeys, useOnResume, useSoftkeys } from '../app/router';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { pickEmoji, pickReaction } from '../components/Emoji';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/List';
import { confirm, DIVIDER, type MenuEntry, pick, pickMany, prompt, showOptions } from '../components/Overlays';
import { RichText } from '../components/RichText';
import { Screen } from '../components/Screen';
import { TextField } from '../components/TextField';
import { toast } from '../components/Toast';
import { recordVoice } from '../components/VoiceRecorder';
import { groupDetail, signal, type GroupDetail } from '../data/api';
import { ATTACHMENT_CACHE_KEEP, autoDownloads, cachedAttachment, isImage, loadAttachment, readDataUri } from '../data/attachments';
import { blurHashUrl, photoBlurHash } from '../data/blurhash';
import { config } from '../data/config';
import { db } from '../data/db';
import { fmtBytes, fmtClock, fmtDay, fmtLength, fmtMsgTime } from '../data/format';
import { fetchLinkPreview, previewCandidate, type FetchedPreview } from '../data/link-preview-fetch';
import { chooseFile, openUrl } from '../data/platform';
import * as store from '../data/store';
import { extractUrls, isJumboEmoji, type PickedMention } from '../data/styled';
import type { Attachment, ContactCard, Conversation, LinkPreview, Message, MessageStatus, Notice, Poll, Quote } from '../data/types';
import { voiceNoteFile, waveformBars } from '../data/voice-recorder';
import { friendlyError, sendError } from '../errors';
import { fmt, S } from '../strings';
import { ChatSettingsScreen } from './ChatSettings';
import { isGroupLink, JoinGroupScreen } from './JoinGroup';
import { MessageDetailsScreen, PollVotesScreen } from './MessageDetails';
import { askUseProxy, isProxyLink } from './Proxy';
import { SafetyNumberScreen } from './SafetyNumber';
import { ForwardScreen } from './SearchList';
import { ViewerScreen } from './Viewer';

const PAGE = 50;
/** Messages kept on screen while following the newest ones; older pages load on demand. */
const MAX_LIVE = 120;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPING_REPEAT_MS = 10000;
const TYPING_IDLE_MS = 5000;
/** Signal allows edits and delete-for-everyone for 24 hours. */
const CHANGE_WINDOW_MS = 24 * 3600 * 1000;
const DRAFT_SAVE_MS = 800;
const PREVIEW_DEBOUNCE_MS = 1000;
const LATEST = Number.MAX_SAFE_INTEGER;
/** How far Up and Down scroll through a message taller than the screen before focus moves on. */
const STEP_PX = 60;
const VOICE_BARS = 32;

export function openChat(convId: string, targetTs?: number): void {
  router.push(ChatScreen, { convId, targetTs });
}

function insertSorted(list: Message[], rec: Message): Message[] {
  if (list.some((m) => m.id === rec.id)) return list.map((m) => (m.id === rec.id ? { ...rec } : m));
  const out = list.slice();
  let i = out.length;
  while (i > 0 && out[i - 1].timestamp > rec.timestamp) i--;
  out.splice(i, 0, { ...rec });
  return out;
}

function authorName(m: Message): string {
  if (!m.incoming) return S.you;
  const known = store.displayName(m.author);
  return known !== m.author ? known : m.authorName || known;
}

function quoteAuthorName(author: string): string {
  return store.isSelf(author) ? S.you : store.displayName(author);
}

function attachmentAction(att: Attachment): string {
  const t = att.contentType || '';
  if (att.viewOnce) return S.viewOnceMedia;
  if (t.indexOf('image/') === 0) return S.viewPhoto;
  if (att.voiceNote || t.indexOf('audio/') === 0) return S.playVoice;
  if (t.indexOf('video/') === 0) return S.playVideo;
  return S.openFile;
}

/** Only admins can send in an announcement-only group. */
function canSendIn(group: GroupDetail | null): boolean {
  if (!group || !group.permissions || group.permissions.send_messages !== 'only-admins') return true;
  return (group.admins || []).some(store.isSelf);
}

function quoteText(q: Quote): string {
  return q.text || store.attachmentLabel(q.attachments) || S.photo;
}

function StatusIcon(props: { status: MessageStatus }) {
  const s = props.status;
  if (s === 'pending') return <Icon name="clock" class="msg-status" />;
  if (s === 'failed') return <Icon name="alert" class="msg-status msg-status-failed" />;
  if (s === 'sent') return <Icon name="check" class="msg-status" />;
  if (s === 'delivered' || s === 'read') return <Icon name="checks" class={'msg-status' + (s === 'read' ? ' msg-status-read' : '')} />;
  return null;
}

/** An inline photo once it's downloaded; anything else is a labelled row that opens in the viewer. `meta` sits over the photo's corner, or below a file row. */
function AttachmentView(props: { att: Attachment; meta?: VNode | null; photoOnly?: boolean }) {
  const { att } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [url, showBlob] = useObjectUrl(att.id);
  useEffect(() => {
    if (!isImage(att) || att.viewOnce || !att.id) return;
    let live = true;
    let io: IntersectionObserver | null = null;
    const show = (b: Blob | null) => {
      if (live && b) showBlob(b);
    };
    cachedAttachment(att).then((b) => {
      if (b) return show(b);
      if (!autoDownloads(att) || !live) return;
      const start = () => loadAttachment(att).then(show, () => {});
      const el = ref.current;
      if (el && typeof IntersectionObserver !== 'undefined') {
        io = new IntersectionObserver(
          (entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            if (io) io.disconnect();
            start();
          },
          { rootMargin: '200px' }
        );
        io.observe(el);
      } else start();
    });
    return () => {
      live = false;
      if (io) io.disconnect();
    };
  }, [att.id]);
  if (url)
    return (
      <div class="msg-media" ref={ref}>
        <img src={url} alt="" />
        {props.meta}
      </div>
    );
  const placeholder = !att.viewOnce && att.blurHash && (isImage(att) || (att.contentType || '').indexOf('video/') === 0) ? blurHashUrl(att.blurHash, att.width, att.height) : null;
  if (placeholder)
    return (
      <div class="msg-media msg-media-blur" ref={ref}>
        <img src={placeholder} alt="" />
        {!isImage(att) && <Icon name="play" class="msg-media-play" />}
        {props.meta}
      </div>
    );
  if (props.photoOnly) return <div ref={ref} />;
  if (!att.viewOnce && (att.contentType || '').indexOf('audio/') === 0 && (att.waveform || att.duration))
    return (
      <>
        <div class="msg-file msg-voice" ref={ref}>
          <Icon name="mic" />
          <span class="msg-wave">
            {waveformBars(att.waveform || [], VOICE_BARS).map((v, i) => (
              <span key={i} class="msg-wave-bar" style={{ height: Math.max(10, Math.round(v * 100)) + '%' }} />
            ))}
          </span>
          {att.duration ? <span class="msg-file-size">{fmtLength(att.duration)}</span> : null}
        </div>
        {props.meta}
      </>
    );
  return (
    <>
      <div class="msg-file" ref={ref}>
        <Icon name={attachmentIcon(att)} />
        <span class="msg-file-name">{att.viewOnce ? S.viewOnceMedia : store.attachmentLabel([att])}</span>
        {!att.viewOnce && att.size ? <span class="msg-file-size">{fmtBytes(att.size)}</span> : null}
      </div>
      {props.meta}
    </>
  );
}

function ContactCardView(props: { card: ContactCard }) {
  const { card } = props;
  const title = card.name || card.phones[0] || card.emails[0];
  const sub = card.name ? card.phones[0] || card.emails[0] : '';
  return (
    <div class="msg-file">
      <Icon name="person" />
      <span class="msg-file-name">{title}</span>
      {sub ? <span class="msg-file-size">{sub}</span> : null}
    </div>
  );
}

function PollView(props: { poll: Poll }) {
  const { poll } = props;
  const counts = store.pollCounts(poll);
  const mine = poll.votes[store.selfNumber()];
  return (
    <div class="poll">
      <div class="poll-question">{poll.question}</div>
      {poll.options.map((o, i) => (
        <div class="poll-option" key={i}>
          <span class={'poll-mark' + (poll.allowMultiple ? ' poll-mark-many' : '') + (mine && mine.options.indexOf(i) >= 0 ? ' on' : '')} />
          <span class="poll-option-text">{o}</span>
          <span class="poll-count">{counts[i]}</span>
        </div>
      ))}
      <div class="poll-sub">{poll.ended ? S.pollEnded : poll.allowMultiple ? S.pollChooseMany : S.pollChooseOne}</div>
    </div>
  );
}

function linkDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A link preview's image only shows once it's on the phone, under the usual download rules. */
function LinkPreviewView(props: { preview: LinkPreview }) {
  const p = props.preview;
  return (
    <div class="msg-link">
      {p.image && <AttachmentView att={p.image} photoOnly />}
      {p.title && <div class="msg-link-title">{p.title}</div>}
      <div class="msg-link-domain">{linkDomain(p.url)}</div>
    </div>
  );
}

/** The Signal user a shared contact's number belongs to, when it's someone we already know. */
function cardContact(card: ContactCard) {
  return store.contactsList().find((c) => !!c.uuid && !!c.number && card.phones.some((p) => p.replace(/[\s()-]/g, '') === c.number));
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

function Reactions(props: { reactions: Record<string, string> }) {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const e of Object.values(props.reactions || {})) {
    if (!counts[e]) order.push(e);
    counts[e] = (counts[e] || 0) + 1;
  }
  if (!order.length) return null;
  return (
    <div class="msg-reactions">
      {order.map((e) => (
        <span key={e} class="msg-reaction">
          <span class="emoji">{e}</span>
          {counts[e] > 1 && <span class="msg-reaction-count">{counts[e]}</span>}
        </span>
      ))}
    </div>
  );
}

function MessageMeta(props: { m: Message }) {
  const { m } = props;
  return (
    <span class="msg-meta">
      {m.pinned && <Icon name="pin" />}
      {m.edited && !m.deleted && <span>{S.edited}</span>}
      {m.expiresAt ? <Icon name="timer" /> : null}
      <span>{fmtClock(m.timestamp)}</span>
      {!m.incoming && <StatusIcon status={m.status} />}
    </span>
  );
}

/** Whether the text overflows its clamp. Measured once per text so moving the time out of the text can't flip it back. */
function useClipped(ref: { current: HTMLElement | null }, text: string): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    setClipped(!!el && el.scrollHeight > el.clientHeight + 2);
  }, [text]);
  return clipped;
}

export function Bubble(props: { m: Message; focused: boolean; showAuthor: boolean; onClipped(id: string, clipped: boolean): void }) {
  const { m } = props;
  const ref = useFocusScroll<HTMLDivElement>(props.focused);
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = m.deleted ? (m.deletedByAdmin ? S.adminDeleted : S.deletedMessage) : m.body;
  const jumbo = !m.deleted && !m.attachments.length && !m.quote && isJumboEmoji(m.body);
  const clipped = useClipped(bodyRef, text || '');
  useEffect(() => props.onClipped(m.id, clipped), [clipped]);
  const attachments = m.deleted ? [] : m.attachments;
  const meta = <MessageMeta m={m} />;
  const preview = m.deleted ? undefined : m.preview;
  const metaInText = !!text && !jumbo && !clipped && !preview;
  const metaOnAttachment = !text && attachments.length > 0;
  const cls = 'msg ' + (m.incoming ? 'msg-in' : 'msg-out') + (props.focused ? ' focused' : '');
  const bubbleCls = 'bubble' + (jumbo ? ' bubble-jumbo' : '') + (m.deleted ? ' bubble-deleted' : '') + (m.status === 'failed' ? ' bubble-failed' : '');
  return (
    <div class={cls} ref={ref} role="listitem">
      <div class={bubbleCls}>
        {props.showAuthor && <div class="msg-author">{authorName(m)}</div>}
        {m.quote && !m.deleted && (
          <div class="msg-quote">
            <div class="msg-quote-author">{quoteAuthorName(m.quote.author)}</div>
            <div class="msg-quote-text">
              {m.quote.attachments && m.quote.attachments.length > 0 && <Icon name={attachmentIcon(m.quote.attachments[0])} />}
              {quoteText(m.quote).slice(0, 120)}
            </div>
          </div>
        )}
        {attachments.map((a, i) => (
          <AttachmentView key={a.id || i} att={a} meta={metaOnAttachment && i === attachments.length - 1 ? meta : null} />
        ))}
        {m.contactCard && !m.deleted && <ContactCardView card={m.contactCard} />}
        {m.poll && !m.deleted && <PollView poll={m.poll} />}
        {text && (
          <div class={'msg-body' + (jumbo ? ' jumbo' : '') + (clipped ? ' clipped' : '')} ref={bodyRef}>
            <RichText text={text} styles={m.deleted ? [] : m.styles} revealSpoilers={props.focused} />
            {metaInText && meta}
          </div>
        )}
        {clipped && <div class="msg-more">{S.readMore}</div>}
        {preview && <LinkPreviewView preview={preview} />}
        {!metaInText && !metaOnAttachment && <div class="msg-meta-line">{meta}</div>}
      </div>
      {!m.deleted && <Reactions reactions={m.reactions} />}
      {m.status === 'failed' && <div class="msg-failed">{S.notSent}</div>}
    </div>
  );
}

function noticeIcon(n: Notice): string {
  if (n.kind === 'safetyNumber') return 'verified';
  if (n.kind === 'pollEnded') return 'poll';
  if (n.kind === 'timer' || (n.kind === 'groupUpdate' && n.change === 'timer')) return 'timer';
  if (n.kind === 'groupUpdate') return 'group';
  return 'phone';
}

export function NoticeLine(props: { m: Message; focused: boolean }) {
  const { m } = props;
  const ref = useFocusScroll<HTMLDivElement>(props.focused);
  return (
    <div class={'notice' + (props.focused ? ' focused' : '')} ref={ref} role="listitem">
      <Icon name={noticeIcon(m.notice!)} />
      <span class="notice-text">{store.noticeText(m.notice!, m.author)}</span>
      <span class="notice-time">{fmtClock(m.timestamp)}</span>
    </div>
  );
}

function canChange(m: Message): boolean {
  return !m.incoming && !m.deleted && (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') && Date.now() - m.timestamp < CHANGE_WINDOW_MS;
}

/** One conversation: messages above, the composer below. Up and Down move between messages and the composer; OK on a message opens its options. */
export function ChatScreen(props: { convId: string; targetTs?: number }) {
  const { convId } = props;
  useStoreEvents(['conversations', 'typing'], (evt, ...args) => evt === 'conversations' || args[0] === convId);
  const conv = store.conversation(convId) as Conversation | undefined;
  const convRef = useRef(conv);
  convRef.current = conv;
  const top = useIsTop();

  const [msgs, setMsgs] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => (conv && conv.draft) || '');
  const [quote, setQuote] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [tray, setTray] = useState<store.OutgoingFile[]>([]);
  const [pinned, setPinned] = useState<Message[]>([]);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const mentionsRef = useRef<PickedMention[]>((conv && conv.draftMentions) || []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const typingRef = useRef<{ last: number; idle: ReturnType<typeof setTimeout> | null }>({ last: 0, idle: null });
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  const clippedIds = useRef(new Set<string>());
  const onClipped = useRef((id: string, clipped: boolean) => {
    if (clipped) clippedIds.current.add(id);
    else clippedIds.current.delete(id);
  }).current;

  const contact = conv && conv.type === 'direct' ? store.contactByKey(conv.id) : undefined;
  const blocked = !!(contact && contact.blocked);
  const request = !blocked && !!(conv && conv.request);
  const readOnly = !blocked && !request && !canSendIn(group);
  const canCompose = !blocked && !request && !readOnly;

  const [linkPreview, setLinkPreview] = useState<FetchedPreview | null>(null);
  const dismissedPreview = useRef('');
  const previewUrl = previewCandidate(draft, { enabled: config.linkPreviews(), plainText: canCompose && !editing && !tray.length });
  const shownPreview = linkPreview && linkPreview.url === previewUrl ? linkPreview : null;
  useEffect(() => {
    if (!previewUrl || previewUrl === dismissedPreview.current) return;
    let live = true;
    const t = setTimeout(() => {
      fetchLinkPreview(previewUrl).then((p) => live && setLinkPreview(p), () => {});
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [previewUrl]);

  const reloadPinned = () => db.getPinned(convId).then(setPinned, () => {});
  const groupSendId = conv && conv.type === 'group' ? conv.sendId : null;
  const reloadGroup = () => {
    if (groupSendId) groupDetail(groupSendId).then(setGroup, () => {});
  };
  useEffect(reloadGroup, [groupSendId]);
  useStoreEvent('conversations', reloadGroup);

  function saveDraft(): void {
    if (!editingRef.current) store.setDraft(convId, draftRef.current, mentionsRef.current);
  }

  useEffect(() => {
    if (editing) return;
    const t = setTimeout(saveDraft, DRAFT_SAVE_MS);
    return () => clearTimeout(t);
  }, [draft, editing]);

  function loadOlder(): Promise<Message[]> {
    const first = msgsRef.current[0];
    if (!first || loadingOlder) return Promise.resolve([]);
    setLoadingOlder(true);
    return db.getMessagesPage(convId, first.timestamp, PAGE).then(
      (rows) => {
        setLoadingOlder(false);
        setHasMore(rows.length === PAGE);
        if (rows.length) setMsgs((cur) => rows.filter((r) => !cur.some((c) => c.id === r.id)).concat(cur));
        return rows;
      },
      () => {
        setLoadingOlder(false);
        return [];
      }
    );
  }

  /** Load older pages until a message at `ts` is on screen, then focus it. */
  async function focusTimestamp(ts: number): Promise<void> {
    for (let pages = 0; pages < 20; pages++) {
      const hit = msgsRef.current.find((m) => m.timestamp === ts) || msgsRef.current.find((m) => m.timestamp >= ts);
      if (hit && msgsRef.current[0].timestamp <= ts) {
        setFocusedId(hit.id);
        return;
      }
      const first = msgsRef.current[0];
      if (!first) return;
      const rows = await db.getMessagesPage(convId, first.timestamp, PAGE);
      if (!rows.length) {
        if (hit) setFocusedId(hit.id);
        return;
      }
      const merged = rows.concat(msgsRef.current);
      msgsRef.current = merged;
      setMsgs(merged);
      setHasMore(rows.length === PAGE);
    }
  }

  useEffect(() => {
    let live = true;
    store.setOpenConv(convId);
    store.markRead(convId);
    if (conv && conv.expireTimer) store.purgeExpiredConv(convId);
    db.pruneAttachments(ATTACHMENT_CACHE_KEEP).catch(() => {});
    db.getMessagesPage(convId, LATEST, PAGE).then(
      (rows) => {
        if (!live) return;
        msgsRef.current = rows;
        setMsgs(rows);
        setHasMore(rows.length === PAGE);
        setLoading(false);
        if (props.targetTs) focusTimestamp(props.targetTs);
      },
      () => live && setLoading(false)
    );
    reloadPinned();
    return () => {
      live = false;
      store.setOpenConv(null);
      stopTyping();
      saveDraft();
    };
  }, [convId]);

  useOnResume(() => {
    store.setOpenConv(convId);
    store.markRead(convId);
  });

  useStoreEvent('message', (rec) => {
    if (rec.convId !== convId) return;
    setMsgs((cur) => {
      let next = insertSorted(cur, rec);
      if (focusedRef.current === null && next.length > MAX_LIVE) {
        next = next.slice(-MAX_LIVE);
        setHasMore(true);
      }
      return next;
    });
    if (top) store.markRead(convId);
  });

  useStoreEvent('message-updated', (rec, oldId) => {
    if (rec.convId !== convId) return;
    const id = oldId || rec.id;
    setMsgs((cur) => cur.map((m) => (m.id === id ? { ...rec } : m)));
    if (oldId && focusedRef.current === oldId) setFocusedId(rec.id);
    reloadPinned();
  });

  useStoreEvent('message-removed', (ref) => {
    if (ref.convId !== convId) return;
    setMsgs((cur) => cur.filter((m) => m.id !== ref.id));
    if (focusedRef.current === ref.id) setFocusedId(null);
    setPinned((cur) => cur.filter((m) => m.id !== ref.id));
  });

  useLayoutEffect(() => {
    if (focusedId === null && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs, focusedId, top, loading, quote, editing]);

  function stopTyping(): void {
    const t = typingRef.current;
    if (t.idle) clearTimeout(t.idle);
    t.idle = null;
    const c = convRef.current;
    if (t.last && c && c.sendId) signal.sendTyping(c.sendId, false).catch(() => {});
    t.last = 0;
  }

  function onDraft(v: string): void {
    setDraft(v);
    const c = convRef.current;
    if (!config.typingIndicators() || !c || !c.sendId || editing) return;
    const t = typingRef.current;
    if (!v.trim()) return stopTyping();
    const now = Date.now();
    if (now - t.last > TYPING_REPEAT_MS) {
      t.last = now;
      signal.sendTyping(c.sendId, true).catch(() => {});
    }
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function insertText(text: string): void {
    const el = inputRef.current;
    const start = el && el.selectionStart != null ? el.selectionStart : draft.length;
    const end = el && el.selectionEnd != null ? el.selectionEnd : start;
    const next = draft.slice(0, start) + text + draft.slice(end);
    onDraft(next);
    setFocusedId(null);
    requestAnimationFrame(() => {
      const e = inputRef.current;
      if (!e) return;
      try {
        e.setSelectionRange(start + text.length, start + text.length);
      } catch {
        // not all inputs keep a selection
      }
    });
  }

  function clearComposer(): void {
    setDraft('');
    mentionsRef.current = [];
  }

  /** Back to the chat's own draft after editing a sent message. */
  function restoreDraft(): void {
    const c = convRef.current;
    setDraft((c && c.draft) || '');
    mentionsRef.current = (c && c.draftMentions) || [];
  }

  function clearContext(): void {
    if (editing) restoreDraft();
    setQuote(null);
    setEditing(null);
  }

  function submit(): void {
    const text = draft.trim();
    if ((!text && !tray.length) || !canCompose) return;
    stopTyping();
    const mentions = mentionsRef.current;
    if (editing) {
      const target = editing;
      setEditing(null);
      restoreDraft();
      store.sendEdit(target, text, mentions).catch((e) => toast(sendError(e)));
      return;
    }
    const q: Quote | null = quote
      ? {
          author: quote.incoming ? quote.author : store.selfNumber(),
          timestamp: quote.timestamp,
          text: quote.body,
          attachments: quote.attachments.length ? quote.attachments.map((a) => ({ contentType: a.contentType, filename: a.filename })) : undefined,
        }
      : null;
    clearComposer();
    setQuote(null);
    store.setDraft(convId, '', []);
    if (tray.length) {
      const files = tray;
      setTray([]);
      store.sendAttachments(convId, files, text, { quote: q }).catch((e) => toast(sendError(e)));
      return;
    }
    const preview = shownPreview;
    setLinkPreview(null);
    dismissedPreview.current = '';
    store.sendText(convId, text, q, mentions, preview).catch((e) => toast(sendError(e)));
  }

  /** Photos, videos, and files wait above the message box until Send; view-once media and voice messages go alone right away. View-once media goes without a caption, so the draft stays in the composer. */
  async function attach(viewOnce: boolean): Promise<void> {
    const file = await chooseFile(viewOnce ? 'image/*,video/*' : undefined);
    if (!file) return;
    const type = file.type || 'application/octet-stream';
    if (viewOnce && type.indexOf('image/') !== 0 && type.indexOf('video/') !== 0) return toast(S.viewOnceOnlyMedia);
    if (file.size > MAX_FILE_BYTES) return toast(S.fileTooLarge);
    const alone = viewOnce || type.indexOf('audio/') === 0;
    if (!alone && tray.length >= store.MAX_ATTACHMENTS) return toast(fmt(S.tooManyAttachments, { n: store.MAX_ATTACHMENTS }));
    if (!alone && tray.reduce((sum, f) => sum + (f.size || 0), 0) + file.size > MAX_FILE_BYTES) return toast(S.attachmentsTooLarge);
    toast(S.preparingFile);
    try {
      const out: store.OutgoingFile = { dataUri: await readDataUri(file, file.name), contentType: type, filename: file.name, size: file.size };
      if (type.indexOf('image/') === 0) Object.assign(out, await photoBlurHash(file));
      if (!alone) {
        setTray((cur) => cur.concat(out));
        setFocusedId(null);
        return;
      }
      const caption = viewOnce ? '' : draft.trim();
      if (!viewOnce) {
        clearComposer();
        store.setDraft(convId, '', []);
      }
      await store.sendAttachments(convId, [out], caption, { viewOnce });
    } catch (e) {
      toast(sendError(e));
    }
  }

  /** A voice message goes alone, without the draft, as in Signal. */
  async function voiceMessage(): Promise<void> {
    const note = await recordVoice();
    if (!note) return;
    try {
      await store.sendAttachments(convId, [await voiceNoteFile(note)], '');
    } catch (e) {
      toast(sendError(e));
    }
  }

  async function pickAttachment(m: Message): Promise<void> {
    const i = await pick(
      S.viewAttachments,
      m.attachments.map((a, n) => ({ value: n, label: a.filename || store.attachmentLabel([a]), sub: a.size ? fmtBytes(a.size) : undefined })),
      -1
    );
    if (i !== undefined && i >= 0) openAttachment(m, m.attachments[i]);
  }

  function openAttachment(m: Message, att: Attachment): void {
    router.push(ViewerScreen, { att, title: authorName(m), onOpened: () => store.markViewed(m) });
  }

  async function mention(): Promise<void> {
    if (!conv || !conv.sendId) return toast(S.groupNotReady);
    const detail = await groupDetail(conv.sendId);
    const me = store.selfNumber();
    const options = (detail.members || []).filter((id) => id !== me && id !== config.aci()).map((id) => ({ value: id, label: store.displayName(id) }));
    if (!options.length) return toast(S.groupNotReady);
    const id = await pick(S.mention, options, '');
    if (!id) return;
    const name = store.displayName(id);
    mentionsRef.current = mentionsRef.current.filter((p) => p.uuid !== id).concat({ name, uuid: id });
    insertText('@' + name + ' ');
  }

  async function react(m: Message): Promise<void> {
    const mine = (m.reactions || {})[store.selfNumber()] || null;
    const emoji = await pickReaction(mine);
    if (emoji === undefined) return;
    store.reactTo(m, emoji).catch((e) => toast(sendError(e)));
  }

  async function openLinks(urls: string[]): Promise<void> {
    const url = urls.length === 1 ? urls[0] : await pick(S.openLink, urls.map((u) => ({ value: u, label: u })), '');
    if (url && isGroupLink(url)) router.push(JoinGroupScreen, { url });
    else if (url && isProxyLink(url)) void askUseProxy(url);
    else if (url) openUrl(url).catch(() => toast(S.errGeneric));
  }

  function copyText(text: string): void {
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

  function contactCardOptions(m: Message) {
    const card = !m.deleted && m.contactCard;
    if (!card) return [];
    const known = cardContact(card);
    if (known) return [{ label: fmt(S.messageName, { name: card.name || store.displayName(known.id) }), onSelect: () => openChat(store.conversationWith(known).id) }];
    return card.phones.length ? [{ label: S.copyNumber, onSelect: () => copyText(card.phones[0]) }] : [];
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

  async function createPoll(): Promise<void> {
    const question = await prompt({ title: S.pollQuestion, maxLength: 100 });
    if (!question) return;
    const options: string[] = [];
    while (options.length < 10) {
      const enough = options.length >= 2;
      const o = await prompt({ title: fmt(S.pollOption, { n: options.length + 1 }), maxLength: 100, allowEmpty: enough, hint: enough ? S.pollOptionHint : undefined });
      if (o === undefined) return;
      if (!o) break;
      options.push(o);
    }
    if (options.length < 2) return toast(S.pollNeedsOptions);
    const many = await pick(S.pollAnswers, [{ value: false, label: S.pollOneAnswer }, { value: true, label: S.pollManyAnswers }], false);
    if (many === undefined) return;
    store.sendPoll(convId, question, options, many).catch((e) => toast(sendError(e)));
  }

  function messageOptions(m: Message): void {
    if (m.notice) return noticeOptions(m);
    const urls = m.deleted ? [] : extractUrls(m.body);
    const att = m.attachments[0];
    const settled = m.status !== 'failed' && m.status !== 'pending' && !request;
    const main: Record<MainAction, MenuEntry[]> = {
      retry: [{ label: S.retry, onSelect: () => store.retryMessage(m).catch((e) => toast(sendError(e))) }],
      attachment: m.attachments.length > 1 ? [{ label: S.viewAttachments, onSelect: () => pickAttachment(m) }] : [att && { label: attachmentAction(att), onSelect: () => openAttachment(m, att) }],
      vote: [!!conv && conv.type === 'group' && !request && { label: S.vote, onSelect: () => vote(m) }],
      card: contactCardOptions(m),
      readFull: [{ label: S.readFull, onSelect: () => router.push(MessageDetailsScreen, { msg: m }) }],
      openLink: [{ label: S.openLink, onSelect: () => openLinks(urls) }],
    };
    const lead = mainActions(m, clippedIds.current.has(m.id));
    showOptions([
      ...lead.reduce<MenuEntry[]>((acc, k) => acc.concat(main[k]), []),
      DIVIDER,
      !m.deleted && settled && { label: S.react, onSelect: () => react(m) },
      !m.deleted && settled && {
        label: S.reply,
        onSelect: () => {
          if (editing) restoreDraft();
          setEditing(null);
          setQuote(m);
          setFocusedId(null);
        },
      },
      DIVIDER,
      !m.deleted && !!m.body && { label: S.copyText, onSelect: () => copyText(m.body) },
      settled && canForward(m) && { label: S.forward, onSelect: () => router.push(ForwardScreen, { msg: m }) },
      canChange(m) && !m.attachments.length && !m.poll && (m.history || []).length < store.MAX_EDITS && {
        label: S.edit,
        onSelect: () => {
          saveDraft();
          setQuote(null);
          setEditing(m);
          setDraft(m.raw != null ? m.raw : m.body);
          mentionsRef.current = m.mentions || [];
          setFocusedId(null);
        },
      },
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
      canAdminDelete(m) && {
        label: S.deleteForEveryone,
        danger: true,
        onSelect: async () => {
          if (await confirm({ title: S.deleteForEveryone, body: S.adminDeleteBody, ok: S.delete, danger: true })) store.adminDelete(m).catch((e) => toast(friendlyError(e)));
        },
      },
    ]);
  }

  function canAdminDelete(m: Message): boolean {
    return m.incoming && !m.deleted && !m.notice && !!group && (group.admins || []).some(store.isSelf) && Date.now() - m.timestamp < store.ADMIN_DELETE_MAX_AGE;
  }

  async function showPinned(): Promise<void> {
    const id = await pick(
      S.pinnedMessages,
      pinned.map((m) => ({ value: m.id, label: m.body || store.attachmentLabel(m.attachments), sub: authorName(m) + ' · ' + fmtMsgTime(m.timestamp) })),
      ''
    );
    const m = id && pinned.find((p) => p.id === id);
    if (m) focusTimestamp(m.timestamp);
  }

  function acceptRequest(): void {
    store.acceptRequest(convId).catch((e) => toast(friendlyError(e)));
  }

  async function deleteRequest(): Promise<void> {
    if (!(await confirm({ title: S.deleteChatTitle, body: S.deleteChatBody, ok: S.delete, danger: true }))) return;
    store.deleteRequest(convId).then(
      () => router.pop(),
      (e) => toast(friendlyError(e))
    );
  }

  async function blockRequest(): Promise<void> {
    if (!(await confirm({ title: S.block, body: S.blockConfirm, ok: S.block, danger: true }))) return;
    store.blockRequest(convId).then(
      () => toast(S.blocked),
      (e) => toast(friendlyError(e))
    );
  }

  async function reportSpam(): Promise<void> {
    if (!(await confirm({ title: S.reportSpam + '?', body: S.reportSpamBody, ok: S.report, danger: true }))) return;
    store.reportSpamRequest(convId).then(
      () => {
        toast(S.reportedSpam);
        router.pop();
      },
      (e) => toast(friendlyError(e))
    );
  }

  function chatOptions(): void {
    showOptions([
      request && { label: S.accept, onSelect: acceptRequest },
      request && { label: S.delete, danger: true, onSelect: deleteRequest },
      request && { label: S.block, danger: true, onSelect: blockRequest },
      request && { label: S.reportSpam, danger: true, onSelect: reportSpam },
      DIVIDER,
      canCompose && !editing && { label: S.attach, onSelect: () => attach(false) },
      canCompose && !editing && { label: S.attachViewOnce, onSelect: () => attach(true) },
      canCompose && !editing && { label: S.recordVoice, onSelect: voiceMessage },
      tray.length > 0 && { label: S.removeAttachments, danger: true, onSelect: () => setTray([]) },
      shownPreview && {
        label: S.removeLinkPreview,
        onSelect: () => {
          dismissedPreview.current = shownPreview.url;
          setLinkPreview(null);
        },
      },
      canCompose && { label: S.insertEmoji, onSelect: () => pickEmoji().then((e) => e && insertText(e)) },
      canCompose && conv && conv.type === 'group' && { label: S.mention, onSelect: mention },
      canCompose && conv && conv.type === 'group' && { label: S.createPoll, onSelect: createPoll },
      DIVIDER,
      pinned.length > 0 && { label: S.pinnedMessages, onSelect: showPinned },
      DIVIDER,
      conv && { label: conv.muted ? S.unmute : S.muteNotifications, onSelect: () => store.setMuted(convId, !conv.muted) },
      { label: S.chatSettings, onSelect: () => router.push(ChatSettingsScreen, { convId }) },
    ]);
  }

  function unblock(): void {
    if (!conv || !conv.sendId) return;
    signal.setContactBlocked(conv.sendId, false).then(
      () => toast(S.unblocked),
      (e) => toast(friendlyError(e))
    );
  }

  const index = focusedId === null ? -1 : msgs.findIndex((m) => m.id === focusedId);
  const onComposer = index < 0;

  /** Scrolls a step through the focused message when it doesn't fit, so its hidden edge comes into view before focus moves. */
  function stepThroughTall(down: boolean): boolean {
    const list = listRef.current;
    const el = list && (list.querySelector('.msg.focused') as HTMLElement | null);
    if (!list || !el) return false;
    const view = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const hidden = down ? r.bottom - view.bottom : view.top - r.top;
    if (hidden <= 1) return false;
    list.scrollTop += (down ? 1 : -1) * Math.min(STEP_PX, hidden);
    return true;
  }

  useKeys((e) => {
    switch (e.key) {
      case 'ArrowUp': {
        if (onComposer) {
          const el = inputRef.current;
          if (el && el.selectionStart) return false;
          if (msgs.length) setFocusedId(msgs[msgs.length - 1].id);
          return true;
        }
        if (stepThroughTall(false)) return true;
        if (index > 0) setFocusedId(msgs[index - 1].id);
        else if (hasMore)
          loadOlder().then((rows) => {
            if (rows.length) setFocusedId(rows[rows.length - 1].id);
          });
        return true;
      }
      case 'ArrowDown':
        if (onComposer) return false;
        if (stepThroughTall(true)) return true;
        setFocusedId(index < msgs.length - 1 ? msgs[index + 1].id : null);
        return true;
      case 'Enter':
        if (onComposer) {
          if (blocked) unblock();
          else if (request) acceptRequest();
          else if (canCompose) submit();
        } else messageOptions(msgs[index]);
        return true;
      case 'SoftRight':
        chatOptions();
        return true;
      case 'Call':
        if (e.repeat && canCompose && !editing) voiceMessage();
        return true;
      case 'SoftLeft':
        if (!quote && !editing) return false;
        clearContext();
        return true;
      case 'Backspace':
        if (!onComposer) {
          setFocusedId(null);
          return true;
        }
        if (draft || (!quote && !editing)) return false;
        clearContext();
        return true;
    }
    return false;
  });

  useSoftkeys({
    left: quote || editing ? S.cancel : undefined,
    center: onComposer ? (blocked ? S.unblock : request ? S.accept : canCompose && (draft.trim() || tray.length) ? (editing ? S.save : S.send) : null) : S.select,
    right: S.options,
  });

  const typing = store.typing(convId);
  const typingName = typing ? (conv && conv.type === 'group' ? fmt(S.isTyping, { name: store.displayName(typing.author) }) : S.typingNow) : '';
  const lastPinned = pinned[pinned.length - 1];

  let prevDay = '';
  let prev: Message | null = null;
  const rows = msgs.map((m) => {
    const day = fmtDay(m.timestamp);
    const showDay = day !== prevDay;
    const showAuthor = !!conv && conv.type === 'group' && m.incoming && (showDay || !prev || !prev.incoming || !!prev.notice || prev.author !== m.author);
    prevDay = day;
    prev = m;
    return (
      <div key={m.id}>
        {showDay && <div class="day-sep">{day}</div>}
        {m.notice ? <NoticeLine m={m} focused={m.id === focusedId} /> : <Bubble m={m} focused={m.id === focusedId} showAuthor={showAuthor} onClipped={onClipped} />}
      </div>
    );
  });

  return (
    <Screen
      title={(conv && conv.name) || S.unknown}
      bodyClass="chat-body"
      banner={
        <>
          <ConnectionBanner />
          {lastPinned && (
            <div class="pinned-bar">
              <Icon name="pin" />
              <span class="pinned-text">{lastPinned.body || store.attachmentLabel(lastPinned.attachments)}</span>
              {pinned.length > 1 && <span class="pinned-count">{pinned.length}</span>}
            </div>
          )}
        </>
      }
    >
      <div class="chat-list" ref={listRef} role="list">
        {loading ? <Spinner /> : !msgs.length ? <div class="chat-empty">{S.noMessages}</div> : null}
        {loadingOlder && <Spinner label={S.earlierMessages} />}
        {rows}
      </div>
      <div class={'composer' + (onComposer ? ' focused' : '')}>
        {typingName && <div class="composer-typing">{typingName}</div>}
        {(quote || editing) && (
          <div class="composer-ctx">
            <div class="composer-ctx-title">{editing ? S.editing : S.replyingTo + ' ' + authorName(quote!)}</div>
            <div class="composer-ctx-text">{(editing || quote)!.body || store.attachmentLabel((editing || quote)!.attachments)}</div>
          </div>
        )}
        {tray.length > 0 && canCompose && (
          <div class="composer-ctx">
            <div class="composer-ctx-title">{store.attachmentLabel(tray)}</div>
            <div class="composer-ctx-text">{tray.map((f) => f.filename).join(', ')}</div>
          </div>
        )}
        {shownPreview && (
          <div class="composer-ctx">
            <div class="composer-ctx-title">{S.linkPreview}</div>
            <div class="composer-ctx-text">{shownPreview.title}</div>
          </div>
        )}
        {blocked ? (
          <div class="composer-blocked">{S.blockedChat}</div>
        ) : request ? (
          <div class="composer-blocked">
            <div class="composer-request">{fmt(S.wantsToMessage, { name: (conv && conv.name) || S.unknown })}</div>
            {S.requestHint}
          </div>
        ) : readOnly ? (
          <div class="composer-blocked">{S.onlyAdminsCanSend}</div>
        ) : (
          <TextField focused={onComposer} value={draft} onInput={onDraft} placeholder={S.messagePlaceholder} multiline maxLines={3} inputRef={inputRef} />
        )}
      </div>
    </Screen>
  );
}
