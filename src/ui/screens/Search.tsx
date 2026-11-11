import { useEffect, useState } from 'preact/hooks';
import { Avatar } from '../components/Avatar';
import { EmptyState, Spinner } from '../components/List';
import { EmojiText } from '../components/RichText';
import type { Row } from '../components/RowList';
import { matches, SearchList } from '../components/SearchList';
import { db } from '../data/db';
import { fmtTime } from '../data/format';
import * as store from '../data/store';
import type { Message } from '../data/types';
import { S } from '../strings';
import { openChat } from './Chat';

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
