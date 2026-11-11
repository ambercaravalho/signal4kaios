import { useEffect, useRef, useState } from 'preact/hooks';
import { useStoreEvent } from '../../app/hooks';
import { useOnResume } from '../../app/router';
import { type GroupDetail, groupDetail } from '../../data/api';
import { ATTACHMENT_CACHE_KEEP } from '../../data/attachments';
import { db } from '../../data/db';
import * as store from '../../data/store';
import type { Message } from '../../data/types';

const PAGE = 50;
/** Messages kept on screen while following the newest ones; older pages load on demand. */
const MAX_LIVE = 120;
const LATEST = Number.MAX_SAFE_INTEGER;

function insertSorted(list: Message[], rec: Message): Message[] {
  if (list.some((m) => m.id === rec.id)) return list.map((m) => (m.id === rec.id ? { ...rec } : m));
  const out = list.slice();
  let i = out.length;
  while (i > 0 && out[i - 1].timestamp > rec.timestamp) i--;
  out.splice(i, 0, { ...rec });
  return out;
}

/** An open chat's messages, pinned messages, and group detail, kept current from store events. `onLeave` runs when the chat closes. */
export function useChatSession(convId: string, targetTs: number | undefined, top: boolean, onLeave: () => void) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Message[]>([]);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const conv = store.conversation(convId);

  const reloadPinned = () => db.getPinned(convId).then(setPinned, () => {});
  const groupSendId = conv && conv.type === 'group' ? conv.sendId : null;
  const reloadGroup = () => {
    if (groupSendId) groupDetail(groupSendId).then(setGroup, () => {});
  };
  useEffect(reloadGroup, [groupSendId]);
  useStoreEvent('conversations', reloadGroup);

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
        if (targetTs) focusTimestamp(targetTs);
      },
      () => live && setLoading(false)
    );
    reloadPinned();
    return () => {
      live = false;
      store.setOpenConv(null);
      leave.current();
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

  return { msgs, hasMore, loading, loadingOlder, focusedId, setFocusedId, pinned, group, loadOlder, focusTimestamp };
}
