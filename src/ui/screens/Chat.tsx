import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useFocusScroll } from '../app/focus';
import { useStoreEvent, useStoreEvents } from '../app/hooks';
import { router, useIsTop, useKeys, useOnResume, useSoftkeys } from '../app/router';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { pickEmoji, pickReaction } from '../components/Emoji';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/List';
import { confirm, DIVIDER, pick, showOptions } from '../components/Overlays';
import { RichText } from '../components/RichText';
import { Screen } from '../components/Screen';
import { TextField } from '../components/TextField';
import { toast } from '../components/Toast';
import { groupDetail, signal } from '../data/api';
import { ATTACHMENT_CACHE_KEEP, autoDownloads, cachedAttachment, isImage, loadAttachment } from '../data/attachments';
import { config } from '../data/config';
import { db } from '../data/db';
import { fmtBytes, fmtClock, fmtDay, fmtMsgTime } from '../data/format';
import { openUrl } from '../data/platform';
import * as store from '../data/store';
import { extractUrls, isJumboEmoji } from '../data/styled';
import type { Attachment, Conversation, Message, MessageStatus } from '../data/types';
import { friendlyError, sendError } from '../errors';
import { fmt, S } from '../strings';
import { ChatSettingsScreen } from './ChatSettings';
import { MessageDetailsScreen } from './MessageDetails';
import { ViewerScreen } from './Viewer';

const PAGE = 50;
/** Messages kept on screen while following the newest ones; older pages load on demand. */
const MAX_LIVE = 120;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPING_REPEAT_MS = 10000;
const TYPING_IDLE_MS = 5000;
/** Signal allows edits and delete-for-everyone for 24 hours. */
const CHANGE_WINDOW_MS = 24 * 3600 * 1000;
const LATEST = Number.MAX_SAFE_INTEGER;
/** How far Up and Down scroll through a message taller than the screen before focus moves on. */
const STEP_PX = 60;

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
  return author === store.selfNumber() || author === config.aci() ? S.you : store.displayName(author);
}

function attachmentAction(att: Attachment): string {
  const t = att.contentType || '';
  if (att.viewOnce) return S.viewOnceMedia;
  if (t.indexOf('image/') === 0) return S.viewPhoto;
  if (att.voiceNote || t.indexOf('audio/') === 0) return S.playVoice;
  if (t.indexOf('video/') === 0) return S.playVideo;
  return S.openFile;
}

function attachmentIcon(att: Attachment): string {
  const t = att.contentType || '';
  if (att.voiceNote || t.indexOf('audio/') === 0) return 'mic';
  if (t.indexOf('video/') === 0) return 'play';
  if (t.indexOf('image/') === 0) return 'photo';
  return 'file';
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
function AttachmentView(props: { att: Attachment; meta?: VNode | null }) {
  const { att } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage(att) || att.viewOnce || !att.id) return;
    let live = true;
    let obj: string | null = null;
    let io: IntersectionObserver | null = null;
    const show = (b: Blob | null) => {
      if (!live || !b) return;
      obj = URL.createObjectURL(b);
      setUrl(obj);
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
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [att.id]);
  if (url)
    return (
      <div class="msg-media" ref={ref}>
        <img src={url} alt="" />
        {props.meta}
      </div>
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
  const text = m.deleted ? S.deletedMessage : m.body;
  const jumbo = !m.deleted && !m.attachments.length && !m.quote && isJumboEmoji(m.body);
  const clipped = useClipped(bodyRef, text || '');
  useEffect(() => props.onClipped(m.id, clipped), [clipped]);
  const attachments = m.deleted ? [] : m.attachments;
  const meta = <MessageMeta m={m} />;
  const metaInText = !!text && !jumbo && !clipped;
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
            <div class="msg-quote-text">{(m.quote.text || S.photo).slice(0, 120)}</div>
          </div>
        )}
        {attachments.map((a, i) => (
          <AttachmentView key={a.id || i} att={a} meta={metaOnAttachment && i === attachments.length - 1 ? meta : null} />
        ))}
        {text && (
          <div class={'msg-body' + (jumbo ? ' jumbo' : '') + (clipped ? ' clipped' : '')} ref={bodyRef}>
            <RichText text={text} styles={m.deleted ? [] : m.styles} revealSpoilers={props.focused} />
            {metaInText && meta}
          </div>
        )}
        {clipped && <div class="msg-more">{S.readMore}</div>}
        {!metaInText && !metaOnAttachment && <div class="msg-meta-line">{meta}</div>}
      </div>
      {!m.deleted && <Reactions reactions={m.reactions} />}
      {m.status === 'failed' && <div class="msg-failed">{S.notSent}</div>}
    </div>
  );
}

function withFilename(dataUri: string, name: string): string {
  if (!name) return dataUri;
  const safe = String(name).replace(/[;,]/g, '_');
  return dataUri.replace(/^data:([^;,]*);base64,/, 'data:$1;filename=' + safe + ';base64,');
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** The OS picker on KaiOS already offers the camera, recorder, and gallery, so one file input covers photos, voice notes, and files. */
function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'hidden';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = (input.files && input.files[0]) || null;
      input.remove();
      resolve(file);
    });
    input.click();
  });
}

function canChange(m: Message): boolean {
  return !m.incoming && !m.deleted && (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') && Date.now() - m.timestamp < CHANGE_WINDOW_MS;
}

/** One conversation: messages above, the composer below. Up and Down move between messages and the composer; OK on a message opens its options. */
export function ChatScreen(props: { convId: string; targetTs?: number }) {
  const { convId } = props;
  useStoreEvents(['conversations', 'typing'], (evt, id) => evt === 'conversations' || id === convId);
  const conv = store.conversation(convId) as Conversation | undefined;
  const convRef = useRef(conv);
  convRef.current = conv;
  const top = useIsTop();

  const [msgs, setMsgs] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [pinned, setPinned] = useState<Message[]>([]);
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

  const reloadPinned = () => db.getPinned(convId).then(setPinned, () => {});

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

  function clearContext(): void {
    if (editing) setDraft('');
    setQuote(null);
    setEditing(null);
  }

  function submit(): void {
    const text = draft.trim();
    if (!text) return;
    stopTyping();
    if (editing) {
      const target = editing;
      setEditing(null);
      setDraft('');
      store.sendEdit(target, text).catch((e) => toast(sendError(e)));
      return;
    }
    const q = quote ? { author: quote.incoming ? quote.author : store.selfNumber(), timestamp: quote.timestamp, text: quote.body } : null;
    setDraft('');
    setQuote(null);
    store.sendText(convId, text, q).catch((e) => toast(sendError(e)));
  }

  async function attach(): Promise<void> {
    const file = await chooseFile();
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return toast(S.fileTooLarge);
    toast(S.preparingFile);
    try {
      const uri = withFilename(await readAsDataUrl(file), file.name);
      const caption = draft.trim();
      setDraft('');
      await store.sendAttachment(convId, uri, caption, { contentType: file.type || 'application/octet-stream', filename: file.name, size: file.size });
    } catch (e) {
      toast(sendError(e));
    }
  }

  async function mention(): Promise<void> {
    if (!conv || !conv.sendId) return toast(S.groupNotReady);
    const detail = await groupDetail(conv.sendId);
    const me = store.selfNumber();
    const options = (detail.members || []).filter((id) => id !== me && id !== config.aci()).map((id) => ({ value: id, label: store.displayName(id) }));
    if (!options.length) return toast(S.groupNotReady);
    const id = await pick(S.mention, options, '');
    if (id) insertText('@' + store.displayName(id) + ' ');
  }

  async function react(m: Message): Promise<void> {
    const mine = (m.reactions || {})[store.selfNumber()] || null;
    const emoji = await pickReaction(mine);
    if (emoji === undefined) return;
    store.reactTo(m, emoji).catch((e) => toast(sendError(e)));
  }

  async function openLinks(urls: string[]): Promise<void> {
    const url = urls.length === 1 ? urls[0] : await pick(S.openLink, urls.map((u) => ({ value: u, label: u })), '');
    if (url) openUrl(url).catch(() => toast(S.errGeneric));
  }

  function copyText(m: Message): void {
    const text = m.body;
    const clip = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
    const fallback = () => {
      insertText(text);
    };
    if (clip && clip.writeText) clip.writeText(text).then(() => toast(S.copied), fallback);
    else fallback();
  }

  function messageOptions(m: Message): void {
    const urls = m.deleted ? [] : extractUrls(m.body);
    const att = m.attachments[0];
    const settled = m.status !== 'failed' && m.status !== 'pending';
    showOptions([
      !m.deleted && settled && { label: S.react, onSelect: () => react(m) },
      !m.deleted && settled && {
        label: S.reply,
        onSelect: () => {
          if (editing) setDraft('');
          setEditing(null);
          setQuote(m);
          setFocusedId(null);
        },
      },
      DIVIDER,
      !m.deleted && att && { label: attachmentAction(att), onSelect: () => router.push(ViewerScreen, { att, title: authorName(m) }) },
      urls.length > 0 && { label: S.openLink, onSelect: () => openLinks(urls) },
      !m.deleted && !!m.body && { label: S.copyText, onSelect: () => copyText(m) },
      canChange(m) && !m.attachments.length && {
        label: S.edit,
        onSelect: () => {
          setQuote(null);
          setEditing(m);
          setDraft(m.raw != null ? m.raw : m.body);
          setFocusedId(null);
        },
      },
      m.status === 'failed' && { label: S.retry, onSelect: () => store.retryMessage(m).catch((e) => toast(sendError(e))) },
      DIVIDER,
      !m.deleted && settled && { label: m.pinned ? S.unpinMessage : S.pinMessage, onSelect: () => store.setMessagePinned(m, !m.pinned).catch((e) => toast(sendError(e))) },
      clippedIds.current.has(m.id) && { label: S.readFull, onSelect: () => router.push(MessageDetailsScreen, { msg: m }) },
      { label: S.messageDetails, onSelect: () => router.push(MessageDetailsScreen, { msg: m }) },
      DIVIDER,
      {
        label: S.deleteForMe,
        onSelect: async () => {
          if (await confirm({ title: S.deleteForMeTitle, body: S.deleteForMeBody, ok: S.delete, danger: true })) store.deleteLocal(m);
        },
      },
      canChange(m) && {
        label: S.deleteForEveryone,
        danger: true,
        onSelect: async () => {
          if (await confirm({ title: S.deleteForEveryone, body: S.deleteForEveryoneBody, ok: S.delete, danger: true })) store.deleteForEveryone(m).catch((e) => toast(friendlyError(e)));
        },
      },
    ]);
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

  function chatOptions(): void {
    showOptions([
      !blocked && { label: S.attach, onSelect: attach },
      !blocked && { label: S.insertEmoji, onSelect: () => pickEmoji().then((e) => e && insertText(e)) },
      !blocked && conv && conv.type === 'group' && { label: S.mention, onSelect: mention },
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
          else submit();
        } else messageOptions(msgs[index]);
        return true;
      case 'SoftRight':
        chatOptions();
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
    center: onComposer ? (blocked ? S.unblock : draft.trim() ? (editing ? S.save : S.send) : null) : S.select,
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
    const showAuthor = !!conv && conv.type === 'group' && m.incoming && (showDay || !prev || !prev.incoming || prev.author !== m.author);
    prevDay = day;
    prev = m;
    return (
      <div key={m.id}>
        {showDay && <div class="day-sep">{day}</div>}
        <Bubble m={m} focused={m.id === focusedId} showAuthor={showAuthor} onClipped={onClipped} />
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
        {blocked ? (
          <div class="composer-blocked">{S.blockedChat}</div>
        ) : (
          <TextField focused={onComposer} value={draft} onInput={onDraft} placeholder={S.messagePlaceholder} multiline maxLines={3} inputRef={inputRef} />
        )}
      </div>
    </Screen>
  );
}
