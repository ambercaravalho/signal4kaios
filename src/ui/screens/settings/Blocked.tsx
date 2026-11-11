import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '../../components/List';
import { confirm } from '../../components/Overlays';
import { RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toast } from '../../components/Toast';
import { signal, syncedContacts, syncedGroups } from '../../data/api';
import * as store from '../../data/store';
import { friendlyError } from '../../errors';
import { S } from '../../strings';

interface BlockedEntry {
  kind: 'contact' | 'group';
  id: string;
  name: string;
  sub: string;
}

export function BlockedScreen() {
  const [list, setList] = useState<BlockedEntry[] | null>(null);
  const load = () =>
    Promise.all([syncedContacts(), syncedGroups()]).then(([cs, gs]) =>
      setList(
        cs
          .filter((c) => c.blocked)
          .map((c): BlockedEntry => ({ kind: 'contact', id: c.uuid || c.number, name: store.contactName(c) || c.number || S.unknown, sub: c.number || '' }))
          .concat(gs.filter((g) => g.blocked).map((g): BlockedEntry => ({ kind: 'group', id: g.id, name: g.name || S.group, sub: S.group })))
      )
    );
  useEffect(() => {
    load();
  }, []);

  async function unblock(e: BlockedEntry): Promise<void> {
    if (!(await confirm({ title: S.unblock + ' ' + e.name + '?', body: e.kind === 'group' ? S.unblockGroupBody : S.unblockBody, ok: S.unblock }))) return;
    const p = e.kind === 'group' ? signal.setGroupBlocked(e.id, false) : signal.setContactBlocked(e.id, false);
    p.then(
      () => {
        toast(S.unblocked);
        load();
      },
      (err) => toast(friendlyError(err))
    );
  }

  return (
    <Screen title={S.blockedPeople}>
      {list === null ? (
        <Spinner />
      ) : (
        <RowList
          rows={list.map((e) => ({ key: e.kind + e.id, label: e.name, sub: e.sub, action: S.unblock, onSelect: () => unblock(e) }))}
          empty={<div class="empty">{S.noBlocked}</div>}
        />
      )}
    </Screen>
  );
}
