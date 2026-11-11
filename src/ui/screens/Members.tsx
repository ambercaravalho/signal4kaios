import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { confirm, DIVIDER, pickMany, prompt, showOptions } from '../components/Overlays';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { runAction } from '../components/setting-rows';
import { toast } from '../components/Toast';
import { signal } from '../data/api';
import * as store from '../data/store';
import { friendlyError } from '../errors';
import { S } from '../strings';
import { ChatScreen } from './Chat';
import { allowed, amAdmin, useGroupDetail } from './group-perms';
import { SafetyNumberScreen } from './SafetyNumber';

/** A group's members and pending invites. OK opens what you can do with a member; the right softkey adds people. */
export function MembersScreen(props: { convId: string }) {
  const conv = store.conversation(props.convId);
  const [d, reload] = useGroupDetail(conv);
  const sendId = conv && conv.sendId;
  if (!conv || !sendId) return <Screen title={S.members} />;
  const admin = amAdmin(d);
  const admins = (d && d.admins) || [];
  const byName = (a: string, b: string) => store.displayName(a).localeCompare(store.displayName(b));
  const members = ((d && d.members) || []).slice().sort(byName);
  const invited = ((d && d.pending) || []).filter((id) => id.indexOf('PNI:') !== 0).sort(byName);
  const requesting = admin ? ((d && d.requesting) || []).slice().sort(byName) : [];
  const canAdd = allowed(d, 'add_members');

  function memberOptions(id: string, pending: boolean): void {
    const isAdmin = admins.indexOf(id) >= 0;
    const name = store.displayName(id);
    showOptions(
      [
        !store.isSelf(id) && !pending && { label: S.messageMember, onSelect: () => router.push(ChatScreen, { convId: store.conversationWith(id.charAt(0) === '+' ? { number: id } : { uuid: id }).id }) },
        !store.isSelf(id) && !pending && { label: S.viewSafetyNumber, onSelect: () => router.push(SafetyNumberScreen, { target: id, name }) },
        DIVIDER,
        admin && pending && { label: S.cancelInvite, onSelect: () => runAction(signal.removeGroupMembers(sendId!, [id]), S.saved, reload) },
        admin && !pending && { label: isAdmin ? S.removeAdmin : S.makeAdmin, onSelect: () => runAction(signal.setGroupAdmins(sendId!, [id], !isAdmin), S.saved, reload) },
        DIVIDER,
        admin && !pending && !store.isSelf(id) && {
          label: S.removeFromGroup,
          danger: true,
          onSelect: async () => {
            if (await confirm({ title: S.removeFromGroup + '?', body: name, ok: S.remove, danger: true })) runAction(signal.removeGroupMembers(sendId!, [id]), S.saved, reload);
          },
        },
      ],
      name
    );
  }

  async function add(): Promise<void> {
    const inGroup = new Set(members.concat(invited));
    const options = store
      .contactsList()
      .filter((c) => c.uuid && !inGroup.has(c.uuid) && !(c.number && inGroup.has(c.number)) && !store.isSelf(c.uuid) && !store.isSelf(c.number))
      .map((c) => ({ value: c.uuid, label: c.name || c.number }));
    let ids: string[] | undefined;
    if (options.length) ids = await pickMany(S.addMembers, options, []);
    else {
      const v = await prompt({ title: S.addMember, placeholder: S.usernamePlaceholder });
      ids = v ? [v.replace(/^@/, '')] : undefined;
    }
    if (!ids || !ids.length) return;
    const before = invited.length;
    signal.addGroupMembers(sendId!, ids).then(
      (state) => {
        toast(state && (state.pending || []).length > before ? S.invitedToGroup : S.addedToGroup);
        reload();
      },
      (e) => toast(friendlyError(e))
    );
  }

  function requestOptions(id: string): void {
    const name = store.displayName(id);
    showOptions(
      [
        { label: S.approve, onSelect: () => runAction(signal.approveGroupRequests(sendId!, [id]), S.saved, reload) },
        {
          label: S.deny,
          danger: true,
          onSelect: async () => {
            if (await confirm({ title: S.denyRequest, body: name, ok: S.deny, danger: true })) runAction(signal.removeGroupMembers(sendId!, [id]), S.saved, reload);
          },
        },
      ],
      name
    );
  }

  const row = (id: string, pending: boolean) => ({
    key: (pending ? 'i:' : 'm:') + id,
    label: store.isSelf(id) ? S.you : store.displayName(id),
    sub: pending ? S.invited : admins.indexOf(id) >= 0 ? S.admin : undefined,
    leading: <Avatar conv={{ id, type: 'direct', name: store.displayName(id) }} />,
    onSelect: () => memberOptions(id, pending),
  });
  const requestRow = (id: string): Row => ({
    key: 'r:' + id,
    label: store.displayName(id),
    sub: S.wantsToJoin,
    leading: <Avatar conv={{ id, type: 'direct', name: store.displayName(id) }} />,
    onSelect: () => requestOptions(id),
  });

  const rows: Row[] = [
    requesting.length > 0 && { section: S.joinRequests },
    ...requesting.map(requestRow),
    requesting.length > 0 && { section: S.members },
    ...members.map((id) => row(id, false)),
    invited.length > 0 && { section: S.pendingInvites },
    ...invited.map((id) => row(id, true)),
  ];
  return (
    <Screen title={S.members + ' (' + members.length + ')'}>
      <RowList
        rows={rows}
        softkeys={(r) => ({ center: r ? S.options : null, right: canAdd ? S.add : null })}
        onKey={(e) => {
          if (e.key !== 'SoftRight' || !canAdd) return false;
          add();
          return true;
        }}
      />
    </Screen>
  );
}
