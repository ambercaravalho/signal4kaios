import { useEffect, useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { confirm, pick, pickMany, prompt, showOptions } from '../components/Overlays';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { groupDetail, renameContact, signal, type GroupDetail } from '../data/api';
import { config } from '../data/config';
import { EXPIRE_OPTIONS, expireLabel } from '../data/format';
import * as store from '../data/store';
import type { Conversation } from '../data/types';
import { friendlyError } from '../errors';
import { plural, S } from '../strings';
import { ChatScreen } from './Chat';
import { QrScreen } from './QrScreen';
import { SafetyNumberScreen } from './SafetyNumber';

type Perm = 'every-member' | 'only-admins';
type PermKey = 'add_members' | 'edit_group' | 'send_messages';
const PERM_DEFAULTS: Record<PermKey, Perm> = { add_members: 'every-member', edit_group: 'only-admins', send_messages: 'every-member' };

function isMe(id: string): boolean {
  return id === config.number() || (!!config.aci() && id === config.aci());
}

function amAdmin(d: GroupDetail | null): boolean {
  return !!d && (d.admins || []).some(isMe);
}

function allowed(d: GroupDetail | null, key: PermKey): boolean {
  if (!d) return false;
  const perms = d.permissions || PERM_DEFAULTS;
  return amAdmin(d) || perms[key] !== 'only-admins';
}

function permLabel(v: Perm | undefined): string {
  return v === 'only-admins' ? S.onlyAdmins : S.allMembers;
}

function linkLabel(mode: string): string {
  if (mode === 'enabled') return S.groupLinkOn;
  if (mode === 'enabled-with-approval') return S.groupLinkApproval;
  return S.groupLinkOff;
}

/** Run a change, toast the outcome, and refresh. */
function run<T>(p: Promise<T>, done: string, after?: () => void): Promise<void> {
  return p.then(
    () => {
      toast(done);
      if (after) after();
    },
    (e) => toast(friendlyError(e))
  );
}

function useGroupDetail(conv: Conversation | undefined): [GroupDetail | null, () => void] {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const sendId = conv && conv.type === 'group' ? conv.sendId : null;
  const load = () => {
    if (sendId) groupDetail(sendId).then(setDetail, () => {});
  };
  useEffect(load, [sendId]);
  useStoreEvents(['conversations']);
  return [detail, load];
}

async function chooseTimer(conv: Conversation): Promise<void> {
  const secs = await pick(S.disappearingMessages, EXPIRE_OPTIONS.map((o) => ({ value: o.secs, label: o.label })), conv.expireTimer || 0);
  if (secs === undefined || !conv.sendId) return;
  const p: Promise<unknown> = conv.type === 'group' ? signal.updateGroup(conv.sendId, { expiration_time: secs }) : signal.setDirectExpireTimer(conv.sendId, secs);
  await run(p, S.disappearingMessages + ': ' + expireLabel(secs), () => store.setConvExpire(conv.id, secs));
}

function muteRow(conv: Conversation): Row {
  return { key: 'mute', label: S.muteNotifications, end: 'toggle', checked: !!conv.muted, action: conv.muted ? S.turnOff : S.turnOn, onSelect: () => store.setMuted(conv.id, !conv.muted) };
}

function directRows(conv: Conversation): Row[] {
  const contact = store.contactByKey(conv.id);
  const recipient = (contact && (contact.uuid || contact.number)) || conv.sendId || conv.id;
  const blocked = !!(contact && contact.blocked);
  const self = store.isSelfConv(conv);

  async function rename(): Promise<void> {
    const name = await prompt({ title: S.nickname, value: conv.name, maxLength: 60 });
    if (!name) return;
    await run(renameContact(recipient, name), S.saved, () => {
      store.setConversationName(conv.id, name);
      store.refreshDirectory().catch(() => {});
    });
  }

  async function toggleBlock(): Promise<void> {
    if (!blocked && !(await confirm({ title: S.block + ' ' + conv.name + '?', body: S.blockConfirm, ok: S.block, danger: true }))) return;
    await run(signal.setContactBlocked(recipient, !blocked), blocked ? S.unblocked : S.blocked, () => {
      if (!blocked) store.setArchived(conv.id, true);
    });
  }

  return [
    !self && { key: 'nick', label: S.nickname, sub: conv.name, onSelect: rename },
    !self && { key: 'timer', label: S.disappearingMessages, sub: expireLabel(conv.expireTimer || 0), onSelect: () => chooseTimer(conv) },
    muteRow(conv),
    !self && { key: 'safety', label: S.viewSafetyNumber, onSelect: () => router.push(SafetyNumberScreen, { target: recipient, name: conv.name }) },
    !self && { key: 'block', label: blocked ? S.unblock : S.block, danger: !blocked, onSelect: toggleBlock },
  ];
}

function groupRows(conv: Conversation, d: GroupDetail | null, reload: () => void): Row[] {
  const sendId = conv.sendId;
  if (!sendId) return [{ key: 'wait', label: S.groupNotReady }, muteRow(conv)];
  const admin = amAdmin(d);
  const canEdit = allowed(d, 'edit_group');
  const perms = (d && d.permissions) || PERM_DEFAULTS;
  const members = (d && d.members) || [];

  async function edit(field: 'name' | 'description'): Promise<void> {
    const value = await prompt({ title: field === 'name' ? S.groupName : S.groupDescription, value: field === 'name' ? (d && d.name) || conv.name : (d && d.description) || '', multiline: field === 'description', allowEmpty: field === 'description', maxLength: field === 'name' ? 32 : 480 });
    if (value === undefined) return;
    await run(signal.updateGroup(sendId!, { [field]: value }), S.saved, () => {
      if (field === 'name') store.setConversationName(conv.id, value);
      store.refreshDirectory().catch(() => {});
      reload();
    });
  }

  async function setPerm(key: PermKey, title: string): Promise<void> {
    const v = await pick<Perm>(title, [{ value: 'every-member', label: S.allMembers }, { value: 'only-admins', label: S.onlyAdmins }], perms[key]);
    if (!v || v === perms[key]) return;
    await run(signal.updateGroup(sendId!, { permissions: { ...PERM_DEFAULTS, ...perms, [key]: v } }), S.saved, reload);
  }

  function groupLink(): void {
    const mode = (d && d.link_mode) || 'disabled';
    const link = d && d.invite_link;
    showOptions(
      [
        !!link && mode !== 'disabled' && { label: S.showQrCode, onSelect: () => router.push(QrScreen, { title: S.groupLink, text: link!, caption: S.groupLinkHint }) },
        mode !== 'disabled' && { label: S.resetLink, onSelect: () => run(signal.updateGroup(sendId!, { group_link: mode, reset_link: true }), S.saved, reload) },
        ...(['disabled', 'enabled', 'enabled-with-approval'] as const)
          .filter((m) => m !== mode)
          .map((m) => ({ label: linkLabel(m), onSelect: () => run(signal.updateGroup(sendId!, { group_link: m }), S.saved, reload) })),
      ],
      S.groupLink
    );
  }

  async function blockGroup(): Promise<void> {
    if (d && d.blocked) return run(signal.setGroupBlocked(sendId!, false), S.unblocked, reload);
    if (!(await confirm({ title: S.blockAndLeave + '?', body: S.blockGroupConfirm, ok: S.block, danger: true }))) return;
    await run(signal.setGroupBlocked(sendId!, true), S.blocked, () => store.setArchived(conv.id, true));
  }

  async function leave(): Promise<void> {
    if (!(await confirm({ title: S.leaveGroup + '?', body: S.leaveGroupConfirm, ok: S.leave, danger: true }))) return;
    await run(signal.leaveGroup(sendId!), S.leftGroup, () => {
      store.setArchived(conv.id, true);
      router.pop();
    });
  }

  return [
    d && d.description ? { key: 'desc', label: S.groupDescription, sub: d.description, onSelect: canEdit ? () => edit('description') : undefined } : canEdit && { key: 'desc', label: S.groupDescription, sub: S.addDescription, onSelect: () => edit('description') },
    { key: 'members', label: S.members, sub: plural(members.length, S.memberOne, S.memberMany), end: 'chevron', onSelect: () => router.push(MembersScreen, { convId: conv.id }) },
    canEdit && { key: 'name', label: S.groupName, sub: (d && d.name) || conv.name, onSelect: () => edit('name') },
    { key: 'timer', label: S.disappearingMessages, sub: expireLabel(conv.expireTimer || 0), onSelect: canEdit ? () => chooseTimer(conv) : undefined },
    muteRow(conv),
    admin && { section: S.permissions },
    admin && { key: 'p-add', label: S.addMembersPermission, sub: permLabel(perms.add_members), onSelect: () => setPerm('add_members', S.addMembersPermission) },
    admin && { key: 'p-edit', label: S.editGroupPermission, sub: permLabel(perms.edit_group), onSelect: () => setPerm('edit_group', S.editGroupPermission) },
    admin && { key: 'p-send', label: S.sendMessagesPermission, sub: permLabel(perms.send_messages), onSelect: () => setPerm('send_messages', S.sendMessagesPermission) },
    admin && { key: 'link', label: S.groupLink, sub: linkLabel((d && d.link_mode) || 'disabled'), onSelect: groupLink },
    { section: '' },
    !!d && { key: 'block', label: d.blocked ? S.unblockGroup : S.blockAndLeave, danger: !d.blocked, onSelect: blockGroup },
    { key: 'leave', label: S.leaveGroup, danger: true, onSelect: leave },
  ];
}

/** Settings for one chat, for a person or a group. */
export function ChatSettingsScreen(props: { convId: string }) {
  const conv = store.conversation(props.convId);
  const [detail, reload] = useGroupDetail(conv);
  if (!conv) return <Screen title={S.chatSettings} />;
  const contact = conv.type === 'direct' ? store.contactByKey(conv.id) : undefined;
  const sub = conv.type === 'group' ? plural(((detail && detail.members) || []).length, S.memberOne, S.memberMany) : contact && contact.number && contact.number !== conv.name ? contact.number : '';
  const rows = conv.type === 'group' ? groupRows(conv, detail, reload) : directRows(conv);
  return (
    <Screen title={S.chatSettings}>
      <div class="profile-head">
        <Avatar conv={conv} size="lg" />
        <div class="profile-name">{conv.name}</div>
        {sub && <div class="profile-sub">{sub}</div>}
      </div>
      <RowList rows={rows} />
    </Screen>
  );
}

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
  const canAdd = allowed(d, 'add_members');

  function memberOptions(id: string, pending: boolean): void {
    const isAdmin = admins.indexOf(id) >= 0;
    const name = store.displayName(id);
    showOptions(
      [
        !isMe(id) && !pending && { label: S.messageMember, onSelect: () => router.push(ChatScreen, { convId: store.conversationWith(id.charAt(0) === '+' ? { number: id } : { uuid: id }).id }) },
        !isMe(id) && !pending && { label: S.viewSafetyNumber, onSelect: () => router.push(SafetyNumberScreen, { target: id, name }) },
        admin && pending && { label: S.cancelInvite, onSelect: () => run(signal.removeGroupMembers(sendId!, [id]), S.saved, reload) },
        admin && !pending && { label: isAdmin ? S.removeAdmin : S.makeAdmin, onSelect: () => run(signal.setGroupAdmins(sendId!, [id], !isAdmin), S.saved, reload) },
        admin && !pending && !isMe(id) && {
          label: S.removeFromGroup,
          danger: true,
          onSelect: async () => {
            if (await confirm({ title: S.removeFromGroup + '?', body: name, ok: S.remove, danger: true })) run(signal.removeGroupMembers(sendId!, [id]), S.saved, reload);
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
      .filter((c) => c.uuid && !inGroup.has(c.uuid) && !(c.number && inGroup.has(c.number)) && !isMe(c.uuid) && !isMe(c.number))
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

  const row = (id: string, pending: boolean) => ({
    key: (pending ? 'i:' : 'm:') + id,
    label: isMe(id) ? S.you : store.displayName(id),
    sub: pending ? S.invited : admins.indexOf(id) >= 0 ? S.admin : undefined,
    leading: <Avatar conv={{ id, type: 'direct', name: store.displayName(id) }} />,
    onSelect: () => memberOptions(id, pending),
  });

  const rows: Row[] = [...members.map((id) => row(id, false)), invited.length > 0 && { section: S.pendingInvites }, ...invited.map((id) => row(id, true))];
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
