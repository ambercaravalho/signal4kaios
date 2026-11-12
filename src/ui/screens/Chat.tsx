import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { revealInScroller } from '../app/focus';
import { useStoreEvents } from '../app/hooks';
import { router, useIsTop } from '../app/router';
import { Bubble, authorName } from '../components/chat/Bubble';
import { messageOptions } from '../components/chat/message-options';
import { NoticeLine } from '../components/chat/NoticeLine';
import { useChatComposer } from '../components/chat/useChatComposer';
import { useChatKeys } from '../components/chat/useChatKeys';
import { useChatSession } from '../components/chat/useChatSession';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { pickEmoji } from '../components/Emoji';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/List';
import { confirm, DIVIDER, pick, prompt, showOptions } from '../components/Overlays';
import { Screen } from '../components/Screen';
import { muteItem } from '../components/setting-rows';
import { TextField } from '../components/TextField';
import { toast } from '../components/Toast';
import { type GroupDetail, signal } from '../data/api';
import { chatColorClass, chatColorOf } from '../data/chat-colors';
import { fmtDay, fmtMsgTime } from '../data/format';
import * as store from '../data/store';
import type { Conversation, Message } from '../data/types';
import { friendlyError, sendError } from '../errors';
import { fmt, S } from '../strings';
import { ChatSettingsScreen } from './ChatSettings';

export { Bubble } from '../components/chat/Bubble';
export { NoticeLine } from '../components/chat/NoticeLine';
export { mainActions, type MainAction } from '../components/chat/message-options';

export function openChat(convId: string, targetTs?: number): void {
  router.push(ChatScreen, { convId, targetTs });
}

/** Who the message request is from: the person, or whoever added us to the group. */
function requestLine(conv: Conversation | undefined): string {
  if (!conv || conv.type !== 'group') return fmt(S.wantsToMessage, { name: (conv && conv.name) || S.unknown });
  const by = store.groupAddedBy(conv);
  return by ? fmt(S.addedYouBy, { name: store.displayName(by) }) : S.addedYou;
}

/** The newest pinned message under the header, and how many there are. */
export function PinnedBar(props: { last: Message; count: number }) {
  return (
    <div class="pinned-bar">
      <Icon name="pin" />
      <span class="pinned-text">{store.previewOf(props.last)}</span>
      {props.count > 1 && <span class="pinned-count">{props.count}</span>}
    </div>
  );
}

/** Only admins can send in an announcement-only group. */
function canSendIn(group: GroupDetail | null): boolean {
  if (!group || !group.permissions || group.permissions.send_messages !== 'only-admins') return true;
  return (group.admins || []).some(store.isSelf);
}

/** One conversation: messages above, the composer below. Up and Down move between messages and the composer; OK on a message opens its options. */
export function ChatScreen(props: { convId: string; targetTs?: number }) {
  const { convId } = props;
  useStoreEvents(['conversations', 'typing'], (evt, ...args) => evt === 'conversations' || args[0] === convId);
  const conv = store.conversation(convId) as Conversation | undefined;
  const top = useIsTop();
  const listRef = useRef<HTMLDivElement>(null);
  const clippedIds = useRef(new Set<string>());
  const onClipped = useRef((id: string, clipped: boolean) => {
    if (clipped) clippedIds.current.add(id);
    else clippedIds.current.delete(id);
  }).current;

  const session = useChatSession(convId, props.targetTs, top, () => composer.leave());
  const { msgs, focusedId, setFocusedId, pinned, group, loading, loadingOlder } = session;

  const contact = conv && conv.type === 'direct' ? store.contactByKey(conv.id) : undefined;
  const blocked = !!(contact && contact.blocked) || !!(group && group.blocked);
  const request = !blocked && !!(conv && conv.request);
  const readOnly = !blocked && !request && !canSendIn(group);
  const canCompose = !blocked && !request && !readOnly;

  const composer = useChatComposer(convId, conv, canCompose, setFocusedId);
  const { draft, quote, editing, tray, shownPreview, insertText } = composer;

  useLayoutEffect(() => {
    if (focusedId === null && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs, focusedId, top, loading, quote, editing]);

  const rowsRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  useEffect(() => {
    const list = listRef.current;
    const rowsEl = rowsRef.current;
    if (!list || !rowsEl || typeof ResizeObserver === 'undefined') return;
    // Photos, previews, and the pinned bar arrive after the list is laid out, so keep the bottom (or the focused message) in view as the rows or the list itself change size.
    const ro = new ResizeObserver(() => {
      if (focusedRef.current === null) list.scrollTop = list.scrollHeight;
      else {
        const el = rowsEl.querySelector('.msg.focused, .notice.focused') as HTMLElement | null;
        if (el) revealInScroller(el);
      }
    });
    ro.observe(rowsEl);
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

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

  async function showPinned(): Promise<void> {
    const id = await pick(
      S.pinnedMessages,
      pinned.map((m) => ({ value: m.id, label: store.previewOf(m), sub: authorName(m) + ' · ' + fmtMsgTime(m.timestamp) })),
      ''
    );
    const m = id && pinned.find((p) => p.id === id);
    if (m) session.focusTimestamp(m.timestamp);
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
    const isGroup = !!conv && conv.type === 'group';
    if (!(await confirm({ title: S.block, body: isGroup ? S.blockGroupConfirm : S.blockConfirm, ok: S.block, danger: true }))) return;
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
      request && conv && conv.type === 'direct' && { label: S.reportSpam, danger: true, onSelect: reportSpam },
      DIVIDER,
      canCompose && !editing && { label: S.attach, onSelect: composer.attach },
      canCompose && !editing && { label: S.recordVoice, onSelect: composer.voiceMessage },
      tray.length > 0 && { label: S.removeAttachments, danger: true, onSelect: () => composer.setTray([]) },
      shownPreview && { label: S.removeLinkPreview, onSelect: composer.dismissPreview },
      canCompose && { label: S.insertEmoji, onSelect: () => pickEmoji().then((e) => e && insertText(e)) },
      canCompose && conv && conv.type === 'group' && { label: S.mention, onSelect: composer.mention },
      canCompose && conv && !store.isSelfConv(conv) && { label: S.createPoll, onSelect: createPoll },
      DIVIDER,
      pinned.length > 0 && { label: S.pinnedMessages, onSelect: showPinned },
      DIVIDER,
      conv && muteItem(conv),
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

  const onComposer = useChatKeys({
    listRef,
    msgs,
    focusedId,
    setFocusedId,
    hasMore: session.hasMore,
    loadOlder: session.loadOlder,
    composer,
    blocked,
    request,
    canCompose,
    unblock,
    acceptRequest,
    messageOptions: (m) => messageOptions(m, { conv, request, group, clipped: clippedIds.current.has(m.id), reply: composer.startReply, edit: composer.startEdit, insertText }),
    chatOptions,
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
      bodyClass={['chat-body', chatColorClass(chatColorOf(conv))].filter(Boolean).join(' ')}
      banner={
        <>
          <ConnectionBanner />
          {lastPinned && <PinnedBar last={lastPinned} count={pinned.length} />}
        </>
      }
    >
      <div class="chat-list" ref={listRef} role="list">
        {loading ? <Spinner /> : !msgs.length ? <div class="chat-empty">{S.noMessages}</div> : null}
        {loadingOlder && <Spinner label={S.earlierMessages} />}
        <div class="chat-rows" ref={rowsRef}>
          {rows}
        </div>
      </div>
      <div class={'composer' + (onComposer ? ' focused' : '')}>
        {typingName && <div class="composer-typing">{typingName}</div>}
        {(quote || editing) && (
          <div class="composer-ctx">
            <div class="composer-ctx-title">{editing ? S.editing : S.replyingTo + ' ' + authorName(quote!)}</div>
            <div class="composer-ctx-text">{store.previewOf((editing || quote)!)}</div>
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
            <div class="composer-request">{requestLine(conv)}</div>
            {conv && conv.type === 'group' ? S.groupRequestHint : S.requestHint}
          </div>
        ) : readOnly ? (
          <div class="composer-blocked">{S.onlyAdminsCanSend}</div>
        ) : (
          <TextField focused={onComposer} value={draft} onInput={composer.onDraft} placeholder={S.messagePlaceholder} multiline maxLines={3} inputRef={composer.inputRef} />
        )}
      </div>
    </Screen>
  );
}
