import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useListNav } from '../app/focus';
import { useStoreEvents } from '../app/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { Avatar } from '../components/Avatar';
import { EmptyState, ListItem, Separator, Spinner } from '../components/List';
import { alertDialog, confirm } from '../components/Overlays';
import { scanQr } from '../components/Qr';
import { EmojiText } from '../components/RichText';
import type { ActionRow, Row } from '../components/RowList';
import { Screen } from '../components/Screen';
import { TextField } from '../components/TextField';
import { toast } from '../components/Toast';
import { signal } from '../data/api';
import { loadAttachment, readDataUri } from '../data/attachments';
import { db } from '../data/db';
import { fmtTime } from '../data/format';
import * as store from '../data/store';
import type { Contact, GroupRef, Message } from '../data/types';
import { friendlyError, sendError } from '../errors';
import { fmt, S } from '../strings';
import { ChatScreen, openChat } from './Chat';

/** A search field above a list of results. Up and Down move between them; OK on the field jumps into the results. */
export function SearchList(props: { title: string; placeholder: string; query: string; onQuery(q: string): void; rows: Row[]; empty?: ComponentChildren; right?: string | null; onRight?(): void }) {
  const rows = props.rows.filter(Boolean) as Array<ActionRow | { section: string }>;
  const actions = rows.filter((r) => !('section' in r)) as ActionRow[];
  const nav = useListNav({
    count: actions.length + 1,
    onEnter: (i) => {
      if (i === 0) {
        if (actions.length) nav.setIndex(1);
        return;
      }
      const r = actions[i - 1];
      if (r && r.onSelect) r.onSelect();
    },
  });
  const row = nav.index > 0 ? actions[nav.index - 1] : undefined;
  useSoftkeys({ center: row ? row.action || S.select : null, right: props.right });
  useKeys((e) => {
    if (e.key !== 'SoftRight' || !props.onRight) return false;
    props.onRight();
    return true;
  });
  let n = 0;
  return (
    <Screen title={props.title}>
      <TextField focused={nav.index === 0} value={props.query} onInput={props.onQuery} placeholder={props.placeholder} />
      {!actions.length && props.empty}
      <div class="list" role="listbox">
        {rows.map((r, i) => {
          if ('section' in r) return <Separator key={'s' + i} label={r.section} />;
          n += 1;
          return <ListItem key={r.key || r.label + i} focused={n === nav.index} primary={r.label} secondary={r.sub} meta={r.meta} leading={r.leading} icon={r.icon} />;
        })}
      </div>
    </Screen>
  );
}

function normalizeNumber(v: string): string {
  const n = v.replace(/[\s()-]/g, '');
  return n && n.charAt(0) !== '+' ? '+' + n : n;
}

function looksLikeNumber(v: string): boolean {
  return /^\+?[\d\s()-]{6,20}$/.test(v);
}

function contactRow(c: Contact, onSelect: () => void): ActionRow {
  const name = c.name || c.number || S.unknown;
  return { key: 'c:' + c.id, label: name, sub: c.number && c.number !== name ? c.number : undefined, leading: <Avatar conv={{ id: c.id, type: 'direct', name }} />, onSelect };
}

function groupRow(g: GroupRef, onSelect: () => void): ActionRow {
  return { key: 'g:' + g.internal_id, label: g.name || S.group, leading: <Avatar conv={{ id: 'g:' + g.internal_id, type: 'group', name: g.name, groupInternalId: g.internal_id }} />, onSelect };
}

function matches(hay: string | undefined, q: string): boolean {
  return !!hay && hay.toLowerCase().indexOf(q) >= 0;
}

/** Start a chat with a contact, a group, or someone found by username or phone number. */
export function NewChatScreen() {
  useStoreEvents(['conversations']);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const q = query.trim();
  const lq = q.toLowerCase();
  const digits = lq.replace(/[\s()-]/g, '');

  const open = (convId: string) => router.replace(ChatScreen, { convId });

  async function findByUsername(raw: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await signal.lookupUsername(raw);
      if (res && res.uuid) open(store.conversationWith({ uuid: res.uuid, name: '@' + res.username }).id);
      else alertDialog(S.usernameNotFound, fmt(S.usernameNotFoundBody, { name: '@' + raw.replace(/^@/, '') }));
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  function findByPhone(raw: string): void {
    const n = normalizeNumber(raw);
    const c = store.contactsList().find((x) => x.number === n && !!x.uuid);
    if (c) open(store.conversationWith(c).id);
    else alertDialog(S.phoneNotFound, S.phoneNotFoundBody);
  }

  async function scan(): Promise<void> {
    const text = await scanQr(S.scanCode);
    if (!text) return;
    const m = /signal\.me\/#p\/(\+?\d+)/.exec(text) || /^(\+?\d[\d\s()-]{5,})$/.exec(text.trim());
    if (m) setQuery(m[1]);
    else toast(S.scanUnsupported, 4000);
  }

  const contacts = store.contactsList().filter((c) => (c.number || c.uuid) && (!lq || matches(c.name, lq) || (digits.length > 2 && (c.number || '').indexOf(digits) >= 0)));
  const groups = store.groupsList().filter((g) => !lq || matches(g.name, lq));
  const rows: Row[] = [];
  if (q) {
    if (looksLikeNumber(q)) rows.push({ key: '__phone', label: S.findByPhone, sub: normalizeNumber(q), icon: 'person', onSelect: () => findByPhone(q) });
    else rows.push({ key: '__user', label: S.findByUsername, sub: '@' + q.replace(/^@/, ''), icon: 'person', onSelect: () => findByUsername(q) });
  }
  if (contacts.length) rows.push({ section: S.contacts }, ...contacts.map((c) => contactRow(c, () => open(store.conversationWith(c).id))));
  if (groups.length) rows.push({ section: S.groups }, ...groups.map((g) => groupRow(g, () => open(store.groupConversation(g.internal_id).id))));

  return (
    <SearchList
      title={S.newChat}
      placeholder={S.newChatPlaceholder}
      query={query}
      onQuery={setQuery}
      rows={rows}
      right={S.scan}
      onRight={scan}
      empty={busy ? <Spinner /> : !q ? <EmptyState title={S.noContacts} body={S.noContactsHint} /> : null}
    />
  );
}

/** Find chats by name and messages by text. Messages are searched on this phone only. */
export function SearchScreen() {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Message[] | null>(null);
  const q = query.trim();
  const lq = q.toLowerCase();

  useEffect(() => {
    setFound(null);
    if (q.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      db.searchMessages(q, 50).then(
        (rows) => live && setFound(rows),
        () => live && setFound([])
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const chats = lq ? store.conversations().concat(store.archivedConversations()).filter((c) => matches(c.name, lq)) : [];
  const rows: Row[] = [];
  if (chats.length) rows.push({ section: S.chats }, ...chats.map((c) => ({ key: 'chat:' + c.id, label: c.name, leading: <Avatar conv={c} />, action: S.open, onSelect: () => openChat(c.id) })));
  if (found && found.length)
    rows.push(
      { section: S.messages },
      ...found.map((m) => {
        const conv = store.conversation(m.convId);
        const who = m.incoming ? store.displayName(m.author) : S.you;
        return { key: 'm:' + m.id, label: conv ? conv.name : S.unknown, sub: <EmojiText text={who + ': ' + m.body.slice(0, 80)} />, meta: fmtTime(m.timestamp), action: S.open, onSelect: () => conv && openChat(m.convId, m.timestamp) };
      })
    );

  const empty = !q ? <EmptyState title={S.search} body={S.searchHint} /> : q.length >= 2 && found === null ? <Spinner /> : <EmptyState title={S.noResults} />;
  return <SearchList title={S.search} placeholder={S.searchPlaceholder} query={query} onQuery={setQuery} rows={rows} empty={empty} />;
}

/** Pick a chat to forward a message to: recent chats first, then contacts and groups. Attachments are downloaded (or read from the cache) and sent again. */
export function ForwardScreen(props: { msg: Message }) {
  useStoreEvents(['conversations']);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const lq = query.trim().toLowerCase();

  async function forwardTo(convId: () => string, name: string): Promise<void> {
    if (busy || !(await confirm({ title: S.forward, body: fmt(S.forwardTo, { name }), ok: S.send }))) return;
    const m = props.msg;
    const att = m.attachments[0];
    setBusy(true);
    let uri: string | undefined;
    try {
      if (att) {
        toast(S.preparingFile);
        uri = await readDataUri(await loadAttachment(att), att.filename);
      }
    } catch (e) {
      setBusy(false);
      toast(friendlyError(e, S.attachmentFailed));
      return;
    }
    router.pop();
    store.forwardMessage(convId(), m, uri).then(
      () => toast(S.forwarded),
      (e) => toast(sendError(e))
    );
  }

  const recent = store.conversations().filter((c) => !c.request && (!lq || matches(c.name, lq)));
  const inRecent = (id: string) => recent.some((c) => c.id === id);
  const contacts = store.contactsList().filter((c) => (c.number || c.uuid) && !inRecent(c.number || c.uuid) && !inRecent(c.uuid) && (!lq || matches(c.name, lq)));
  const groups = store.groupsList().filter((g) => !inRecent('g:' + g.internal_id) && (!lq || matches(g.name, lq)));
  const rows: Row[] = [];
  if (recent.length) rows.push({ section: S.recentChats }, ...recent.map((c) => ({ key: 'chat:' + c.id, label: c.name, leading: <Avatar conv={c} />, action: S.select, onSelect: () => forwardTo(() => c.id, c.name) })));
  if (contacts.length) rows.push({ section: S.contacts }, ...contacts.map((c) => contactRow(c, () => forwardTo(() => store.conversationWith(c).id, c.name || c.number))));
  if (groups.length) rows.push({ section: S.groups }, ...groups.map((g) => groupRow(g, () => forwardTo(() => store.groupConversation(g.internal_id).id, g.name || S.group))));

  return (
    <SearchList
      title={S.forward}
      placeholder={S.newChatPlaceholder}
      query={query}
      onQuery={setQuery}
      rows={rows}
      empty={busy ? <Spinner label={S.downloading} /> : <EmptyState title={S.noResults} />}
    />
  );
}
