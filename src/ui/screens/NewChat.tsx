import { useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { EmptyState, Spinner } from '../components/List';
import { alertDialog } from '../components/Overlays';
import { scanQr } from '../components/Qr';
import type { Row } from '../components/RowList';
import { contactRow, groupRow, matches, SearchList } from '../components/SearchList';
import { toast } from '../components/Toast';
import { signal } from '../data/api';
import * as store from '../data/store';
import { friendlyError } from '../errors';
import { fmt, S } from '../strings';
import { ChatScreen } from './Chat';
import { isGroupLink, JoinGroupScreen } from './JoinGroup';
import { askUseProxy, isProxyLink } from './Proxy';

function normalizeNumber(v: string): string {
  const n = v.replace(/[\s()-]/g, '');
  return n && n.charAt(0) !== '+' ? '+' + n : n;
}

function looksLikeNumber(v: string): boolean {
  return /^\+?[\d\s()-]{6,20}$/.test(v);
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
    if (isGroupLink(text)) {
      router.push(JoinGroupScreen, { url: text.trim() });
      return;
    }
    if (isProxyLink(text)) {
      void askUseProxy(text);
      return;
    }
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
