import { useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { EmptyState, Spinner } from '../components/List';
import { confirm } from '../components/Overlays';
import type { Row } from '../components/RowList';
import { contactRow, groupRow, matches, SearchList } from '../components/SearchList';
import { toast } from '../components/Toast';
import { loadAttachment, readDataUri } from '../data/attachments';
import * as store from '../data/store';
import type { Message } from '../data/types';
import { friendlyError, sendError } from '../errors';
import { fmt, S } from '../strings';

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
