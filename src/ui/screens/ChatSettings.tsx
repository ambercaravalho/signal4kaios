import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { confirm, DIVIDER, pick, prompt, showOptions } from '../components/Overlays';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { muteLabel, pickTimer, runAction, toggleMute, toggleRow } from '../components/setting-rows';
import { type GroupDetail, renameContact, signal } from '../data/api';
import { expireLabel } from '../data/format';
import * as store from '../data/store';
import type { Conversation } from '../data/types';
import { plural, S } from '../strings';
import { allowed, amAdmin, type Perm, PERM_DEFAULTS, type PermKey, useGroupDetail } from './group-perms';
import { MediaScreen } from './Media';
import { MembersScreen } from './Members';
import { QrScreen } from './QrScreen';
import { SafetyNumberScreen } from './SafetyNumber';

export { MembersScreen } from './Members';

function permLabel(v: Perm | undefined): string {
  return v === 'only-admins' ? S.onlyAdmins : S.allMembers;
}

function linkLabel(mode: string): string {
  if (mode === 'enabled') return S.groupLinkOn;
  if (mode === 'enabled-with-approval') return S.groupLinkApproval;
  return S.groupLinkOff;
}

async function chooseTimer(conv: Conversation): Promise<void> {
  const secs = await pickTimer(S.disappearingMessages, conv.expireTimer || 0);
  if (secs === undefined || !conv.sendId) return;
  const p: Promise<unknown> = conv.type === 'group' ? signal.updateGroup(conv.sendId, { expiration_time: secs }) : signal.setDirectExpireTimer(conv.sendId, secs);
  await runAction(p, S.disappearingMessages + ': ' + expireLabel(secs), () => store.setConvExpire(conv.id, secs));
}

function muteRow(conv: Conversation): Row {
  return { key: 'mute', label: store.isMuted(conv) ? S.unmute : S.muteNotifications, sub: muteLabel(conv), onSelect: () => toggleMute(conv) };
}

const EXCEPTION_LABELS: Record<store.MutedException, string> = { mentions: S.notifyForMentions, replies: S.notifyForReplies, calls: S.notifyForCalls };

/** While a chat is muted: what still notifies (mentions and replies are groups only). */
function exceptionRows(conv: Conversation): Row[] {
  if (!store.isMuted(conv)) return [];
  const kinds: store.MutedException[] = conv.type === 'group' ? ['mentions', 'replies', 'calls'] : ['calls'];
  return kinds.map((k) => toggleRow(k, EXCEPTION_LABELS[k], store.notifiesWhileMuted(conv, k), (v) => store.setNotifyIfMuted(conv.id, k, v)));
}

function directRows(conv: Conversation): Row[] {
  const contact = store.contactByKey(conv.id);
  const recipient = (contact && (contact.uuid || contact.number)) || conv.sendId || conv.id;
  const blocked = !!(contact && contact.blocked);
  const self = store.isSelfConv(conv);

  async function rename(): Promise<void> {
    const name = await prompt({ title: S.nickname, value: conv.name, maxLength: 60 });
    if (!name) return;
    await runAction(renameContact(recipient, name), S.saved, () => {
      store.setConversationName(conv.id, name);
      store.refreshDirectory().catch(() => {});
    });
  }

  async function toggleBlock(): Promise<void> {
    if (!blocked && !(await confirm({ title: S.block + ' ' + conv.name + '?', body: S.blockConfirm, ok: S.block, danger: true }))) return;
    await runAction(signal.setContactBlocked(recipient, !blocked), blocked ? S.unblocked : S.blocked, () => {
      if (!blocked) store.setArchived(conv.id, true);
    });
  }

  return [
    !self && { key: 'nick', label: S.nickname, sub: conv.name, onSelect: rename },
    !self && { key: 'timer', label: S.disappearingMessages, sub: expireLabel(conv.expireTimer || 0), onSelect: () => chooseTimer(conv) },
    muteRow(conv),
    ...(self ? [] : exceptionRows(conv)),
    !self && { key: 'safety', label: S.viewSafetyNumber, onSelect: () => router.push(SafetyNumberScreen, { target: recipient, name: conv.name }) },
    !self && { key: 'block', label: blocked ? S.unblock : S.block, danger: !blocked, onSelect: toggleBlock },
  ];
}

function groupRows(conv: Conversation, d: GroupDetail | null, reload: () => void): Row[] {
  const sendId = conv.sendId;
  if (!sendId) return [{ key: 'wait', label: S.groupNotReady }, muteRow(conv), ...exceptionRows(conv)];
  const admin = amAdmin(d);
  const canEdit = allowed(d, 'edit_group');
  const perms = (d && d.permissions) || PERM_DEFAULTS;
  const members = (d && d.members) || [];

  async function edit(field: 'name' | 'description'): Promise<void> {
    const value = await prompt({ title: field === 'name' ? S.groupName : S.groupDescription, value: field === 'name' ? (d && d.name) || conv.name : (d && d.description) || '', multiline: field === 'description', allowEmpty: field === 'description', maxLength: field === 'name' ? 32 : 480 });
    if (value === undefined) return;
    await runAction(signal.updateGroup(sendId!, { [field]: value }), S.saved, () => {
      if (field === 'name') store.setConversationName(conv.id, value);
      store.refreshDirectory().catch(() => {});
      reload();
    });
  }

  async function setPerm(key: PermKey, title: string): Promise<void> {
    const v = await pick<Perm>(title, [{ value: 'every-member', label: S.allMembers }, { value: 'only-admins', label: S.onlyAdmins }], perms[key]);
    if (!v || v === perms[key]) return;
    await runAction(signal.updateGroup(sendId!, { permissions: { ...PERM_DEFAULTS, ...perms, [key]: v } }), S.saved, reload);
  }

  function groupLink(): void {
    const mode = (d && d.link_mode) || 'disabled';
    const link = d && d.invite_link;
    showOptions(
      [
        !!link && mode !== 'disabled' && { label: S.showQrCode, onSelect: () => router.push(QrScreen, { title: S.groupLink, text: link!, caption: S.groupLinkHint }) },
        mode !== 'disabled' && { label: S.resetLink, onSelect: () => runAction(signal.updateGroup(sendId!, { group_link: mode, reset_link: true }), S.saved, reload) },
        DIVIDER,
        ...(['disabled', 'enabled', 'enabled-with-approval'] as const)
          .filter((m) => m !== mode)
          .map((m) => ({ label: linkLabel(m), onSelect: () => runAction(signal.updateGroup(sendId!, { group_link: m }), S.saved, reload) })),
      ],
      S.groupLink
    );
  }

  async function blockGroup(): Promise<void> {
    if (d && d.blocked) return runAction(signal.setGroupBlocked(sendId!, false), S.unblocked, reload);
    if (!(await confirm({ title: S.blockAndLeave + '?', body: S.blockGroupConfirm, ok: S.block, danger: true }))) return;
    await runAction(signal.setGroupBlocked(sendId!, true), S.blocked, () => store.setArchived(conv.id, true));
  }

  async function leave(): Promise<void> {
    if (!(await confirm({ title: S.leaveGroup + '?', body: S.leaveGroupConfirm, ok: S.leave, danger: true }))) return;
    await runAction(signal.leaveGroup(sendId!), S.leftGroup, () => {
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
    ...exceptionRows(conv),
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
  const media: Row = { key: 'media', label: S.media, icon: 'photo', end: 'chevron', onSelect: () => router.push(MediaScreen, { convId: conv.id }) };
  const rows = [media, ...(conv.type === 'group' ? groupRows(conv, detail, reload) : directRows(conv))];
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
