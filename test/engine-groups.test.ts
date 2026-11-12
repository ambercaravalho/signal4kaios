import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';
import * as zk from '@signalapp/libsignal-client/zkgroup';

import { fromBase64, fromHex, randomBytes, toBase64, toHex } from '../src/engine/bytes';
import {
  AccessControl_AccessRequired,
  GroupAttributeBlobSchema,
  GroupChange_ActionsSchema,
  GroupChangeResponseSchema,
  GroupChangeSchema,
  GroupInviteLinkSchema,
  GroupResponseSchema,
  GroupSchema,
  Member_Role,
  MemberPendingAdminApprovalSchema,
} from '../src/engine/gen/Groups_pb';
import {
  acceptInviteActions,
  addMembersActions,
  applyGroupChange,
  approveRequestsActions,
  inviteLinkActions,
  leaveActions,
  permissionActions,
  removeMembersActions,
  roleActions,
  snapshotGroup,
  titleActions,
} from '../src/engine/services/group-changes';
import { decodeGroupState, deriveGroupV2Keys, groupIdFromMasterKey } from '../src/engine/services/groups-v2';
import { libsignal } from '../src/engine/protocol/libsignal';
import { create, fromBinary, toBinary } from '../src/engine/net/proto';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { ALICE, BOB, CAROL, DAVE, ERIN } from './helpers';
import { loadWasmForTests } from './support';
import { diffGroupState, groupChangeAuthor, groupIsRequest, isDecodedGroup } from '../src/engine/services/group-updates';

before(() => {
  loadWasmForTests();
});

describe('Groups V2 (zkgroup)', () => {
  it('derives a stable 32-byte group identifier and decrypts group attribute blobs and members', () => {
    const masterKey = randomBytes(32);
    const keys = deriveGroupV2Keys(masterKey);
    assert.equal(keys.groupIdentifier.length, 32);
    assert.equal(groupIdFromMasterKey(masterKey), keys.internalId);
    assert.equal(keys.sendId, 'group.' + keys.internalId);

    const title = toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content: { case: 'title', value: 'KaiOS Developers' } }));
    const blob = libsignal.groupEncryptBlob(keys.secretParams, title, 0);
    const decoded = fromBinary(GroupAttributeBlobSchema, libsignal.groupDecryptBlob(keys.secretParams, blob)).content;
    assert.deepEqual(decoded, { case: 'title', value: 'KaiOS Developers' });

    const member = libsignal.groupEncryptServiceId(keys.secretParams, ALICE);
    assert.equal(libsignal.groupDecryptServiceId(keys.secretParams, member), ALICE);
  });
});

describe('Groups V2 changes (PATCH /v2/groups/)', () => {
  const PNI = '99999999-9999-4999-8999-999999999999';

  /** A storage server holding one group (Alice admin, Bob member, Carol invited) that applies title changes and checks auth presentations. */
  function serveGroup(opts: { aliceAdmin?: boolean; bobAdmin?: boolean } = {}) {
    const serverSecret = zk.ServerSecretParams.generate();
    const serverPublic = new Uint8Array(serverSecret.getPublicParams().serialize());
    const masterKey = randomBytes(32);
    const keys = deriveGroupV2Keys(masterKey);
    const enc = (id: string) => libsignal.groupEncryptServiceId(keys.secretParams, id);
    const blob = (content: any) => libsignal.groupEncryptBlob(keys.secretParams, toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content })), 0);
    const group = create(GroupSchema, {
      version: 4,
      title: blob({ case: 'title', value: 'Before' }),
      accessControl: { attributes: AccessControl_AccessRequired.MEMBER, members: AccessControl_AccessRequired.MEMBER, addFromInviteLink: AccessControl_AccessRequired.UNSATISFIABLE },
      members: [
        { userId: enc(ALICE), role: opts.aliceAdmin === false ? Member_Role.DEFAULT : Member_Role.ADMINISTRATOR },
        { userId: enc(BOB), role: opts.bobAdmin ? Member_Role.ADMINISTRATOR : Member_Role.DEFAULT },
      ],
      membersPendingProfileKey: [{ member: { userId: enc(CAROL), role: Member_Role.DEFAULT } }],
    });

    const today = Math.floor(Date.now() / 86400000) * 86400;
    const credential = new zk.ServerZkAuthOperations(serverSecret).issueAuthCredentialWithPniZkc(
      official.Aci.fromUuid(ALICE),
      official.Pni.fromUuid(PNI),
      today
    );
    const httpJson = async (_m: string, path: string) => {
      assert.match(path, /^\/v1\/certificate\/auth\/group\?/);
      return { credentials: [{ credential: toBase64(credential.serialize()), redemptionTime: today }] };
    };

    const calls: string[] = [];
    let respond: number[] = [];
    const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
      calls.push(method);
      assert.equal(url, 'https://storage.signal.org/v2/groups/');
      const [publicHex, presentationHex] = atob(headers!.Authorization.replace(/^Basic /, '')).split(':');
      assert.equal(publicHex, toHex(keys.publicParams));
      new zk.ServerZkAuthOperations(serverSecret).verifyAuthCredentialPresentation(
        new zk.GroupPublicParams(new Uint8Array(keys.publicParams)),
        new zk.AuthCredentialPresentation(new Uint8Array(fromHex(presentationHex)))
      );
      if (method === 'GET') {
        const isMember = group.members.some((m) => libsignal.groupDecryptServiceId(keys.secretParams, m.userId) === ALICE);
        if (!isMember) throw Object.assign(new Error('HTTP 403'), { status: 403 });
        return toBinary(GroupResponseSchema, create(GroupResponseSchema, { group }));
      }
      const status = respond.shift();
      if (status) throw Object.assign(new Error('HTTP ' + status), { status });
      const actions = fromBinary(GroupChange_ActionsSchema, body!);
      assert.equal(actions.version, group.version + 1);
      if (actions.modifyTitle) group.title = actions.modifyTitle.title;
      const deleted = actions.deleteMembers.map((d) => toBase64(d.deletedUserId));
      group.members = group.members.filter((m) => !deleted.includes(toBase64(m.userId)));
      group.version = actions.version;
      return toBinary(GroupChangeResponseSchema, create(GroupChangeResponseSchema, { groupChange: { actions: body!, serverSignature: randomBytes(64) } }));
    };

    const store = new MemorySignalStore({
      aci: ALICE,
      pni: 'PNI:' + PNI,
      number: '',
      deviceId: 2,
      password: 'pw',
      registrationId: 1,
      pniRegistrationId: 2,
      aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
    });
    const deps = { store, httpJson: httpJson as any, httpBinary, serverUrl: 'https://chat.signal.org', serverPublicParams: serverPublic };
    return { deps, masterKey, keys, group, calls, respondWith: (s: number[]) => { respond = s; } };
  }

  it('applies a title change at revision+1 and notifies everyone in the group', async () => {
    const srv = serveGroup();
    const res = await applyGroupChange(srv.deps, srv.masterKey, (snap) => titleActions(snap, 'After'));
    assert.ok(res);
    assert.equal(res.revision, 5);
    assert.equal(res.state.name, 'After');
    assert.deepEqual(res.state.pending, [CAROL]);
    assert.deepEqual(res.notify.sort(), [BOB, CAROL].sort());
    const signed = fromBinary(GroupChangeSchema, res.groupChange);
    assert.equal(fromBinary(GroupChange_ActionsSchema, signed.actions).version, 5);
    assert.deepEqual(srv.calls, ['GET', 'PATCH', 'GET']);
  });

  it('rebuilds once after a 409 and maps 403 to GroupChangeForbidden', async () => {
    const srv = serveGroup();
    srv.respondWith([409]);
    const res = await applyGroupChange(srv.deps, srv.masterKey, (snap) => titleActions(snap, 'Retried'));
    assert.equal(res!.state.name, 'Retried');
    assert.deepEqual(srv.calls, ['GET', 'PATCH', 'GET', 'PATCH', 'GET']);

    srv.respondWith([403]);
    await assert.rejects(applyGroupChange(srv.deps, srv.masterKey, (snap) => titleActions(snap, 'Nope')), (e: any) => e.name === 'GroupChangeForbidden');
    assert.equal(await applyGroupChange(srv.deps, srv.masterKey, () => null), null);
  });

  it('leaves a group and still reports who to notify once the server hides it', async () => {
    const srv = serveGroup({ bobAdmin: true });
    const res = await applyGroupChange(srv.deps, srv.masterKey, (snap) => leaveActions(snap));
    assert.ok(res);
    assert.equal(res.revision, 5);
    assert.deepEqual(res.state.members, [BOB]);
    assert.deepEqual(res.notify.sort(), [BOB, CAROL].sort());
  });

  it('builds member, role, permission, link, and leave actions against the current group', () => {
    const srv = serveGroup();
    const snap = snapshotGroup(srv.keys, srv.group, ALICE);
    const userId = (id: string) => snap.members.get(id) || snap.pending.get(id);

    const removed = removeMembersActions(snap, [BOB, CAROL])!;
    assert.deepEqual(removed.deleteMembers![0].deletedUserId, userId(BOB));
    assert.deepEqual(removed.deleteMembersPendingProfileKey![0].deletedUserId, userId(CAROL));

    const promoted = roleActions(snap, [BOB, ALICE], true)!;
    assert.equal(promoted.modifyMemberRoles!.length, 1);
    assert.equal(promoted.modifyMemberRoles![0].role, Member_Role.ADMINISTRATOR);

    const added = addMembersActions(snap, [{ aci: DAVE }, { aci: BOB }, { aci: ERIN, presentation: new Uint8Array([1, 2]) }])!;
    assert.equal(libsignal.groupDecryptServiceId(srv.keys.secretParams, added.addMembersPendingProfileKey![0].added!.member!.userId as Uint8Array), DAVE);
    assert.deepEqual(added.addMembers![0].added!.presentation, new Uint8Array([1, 2]));

    assert.equal(permissionActions(snap, { add_members: 'every-member', edit_group: 'every-member', send_messages: 'every-member' }), null);
    assert.deepEqual(permissionActions(snap, { edit_group: 'only-admins' }), { modifyAttributesAccess: { attributesAccess: AccessControl_AccessRequired.ADMINISTRATOR } });

    const link = inviteLinkActions(snap, 'enabled')!;
    assert.equal(link.modifyAddFromInviteLinkAccess!.addFromInviteLinkAccess, AccessControl_AccessRequired.ANY);
    assert.equal((link.modifyInviteLinkPassword!.inviteLinkPassword as Uint8Array).length, 16);
    assert.equal(inviteLinkActions(snap, 'disabled'), null);

    assert.throws(() => leaveActions(snap), (e: any) => e.name === 'LastAdmin');
    const asBob = snapshotGroup(srv.keys, srv.group, BOB);
    assert.deepEqual(leaveActions(asBob).deleteMembers![0].deletedUserId, userId(BOB));
    assert.ok(leaveActions(snapshotGroup(srv.keys, srv.group, CAROL)).deleteMembersPendingProfileKey!.length === 1);
    assert.throws(() => leaveActions(snapshotGroup(srv.keys, srv.group, DAVE)), (e: any) => e.name === 'NotAMember');

    const linked = fromBinary(GroupSchema, toBinary(GroupSchema, srv.group));
    linked.inviteLinkPassword = new Uint8Array(16).fill(7);
    linked.accessControl!.addFromInviteLink = AccessControl_AccessRequired.ADMINISTRATOR;
    const decoded = decodeGroupState(srv.keys, linked);
    assert.equal(decoded.link_mode, 'enabled-with-approval');
    assert.match(decoded.invite_link, /^https:\/\/signal\.group\/#[A-Za-z0-9_-]+$/);
    const inv = fromBinary(GroupInviteLinkSchema, fromBase64(decoded.invite_link.split('#')[1]));
    assert.equal(inv.contents.case, 'contentsV1');
    assert.deepEqual(inv.contents.value!.groupMasterKey, srv.masterKey);
  });

  it('approves join requests like Signal-Desktop and denies them by deleting the request', () => {
    const srv = serveGroup();
    const requested = libsignal.groupEncryptServiceId(srv.keys.secretParams, DAVE);
    srv.group.membersPendingAdminApproval = [create(MemberPendingAdminApprovalSchema, { userId: requested })];
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).requesting, [DAVE]);
    const snap = snapshotGroup(srv.keys, srv.group, ALICE);
    assert.deepEqual(approveRequestsActions(snap, [DAVE, BOB]), { promoteMembersPendingAdminApproval: [{ userId: requested, role: Member_Role.DEFAULT }] });
    assert.equal(approveRequestsActions(snap, [BOB]), null);
    assert.deepEqual(removeMembersActions(snap, [DAVE])!.deleteMembersPendingAdminApproval, [{ deletedUserId: requested }]);
  });

  it('accepts an invite to our account or our number, and reads who invited us', () => {
    const srv = serveGroup();
    const enc = (id: string) => libsignal.groupEncryptServiceId(srv.keys.secretParams, id);
    srv.group.membersPendingProfileKey = [
      { member: { userId: enc(CAROL), role: Member_Role.DEFAULT }, addedByUserId: enc(ALICE) },
      { member: { userId: enc('PNI:' + PNI), role: Member_Role.DEFAULT }, addedByUserId: enc(BOB) },
    ] as any;
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).invitedBy, { [CAROL]: ALICE, ['PNI:' + PNI]: BOB });
    const presentation = new Uint8Array([9, 9]);
    assert.deepEqual(acceptInviteActions(snapshotGroup(srv.keys, srv.group, CAROL), presentation, ''), { promoteMembersPendingProfileKey: [{ presentation }] });
    assert.deepEqual(acceptInviteActions(snapshotGroup(srv.keys, srv.group, DAVE), presentation, PNI), { promoteMembersPendingPniAciProfileKey: [{ presentation }] });
    assert.equal(acceptInviteActions(snapshotGroup(srv.keys, srv.group, BOB), presentation, ''), null);
    assert.throws(() => acceptInviteActions(snapshotGroup(srv.keys, srv.group, ERIN), presentation, ''), (e: any) => e.name === 'NotAMember');
  });

  it('treats a group as a message request unless we trust whoever added us', () => {
    assert.equal(groupIsRequest(false, BOB, ALICE, undefined), true);
    assert.equal(groupIsRequest(false, '', ALICE, undefined), true);
    assert.equal(groupIsRequest(false, BOB, ALICE, { whitelisted: false }), true);
    assert.equal(groupIsRequest(false, BOB, ALICE, { whitelisted: true }), false);
    assert.equal(groupIsRequest(false, BOB, ALICE, { systemContact: true }), false);
    assert.equal(groupIsRequest(false, ALICE, ALICE, undefined), false);
    assert.equal(groupIsRequest(true, BOB, ALICE, undefined), false);
  });

  it('reads who made a signed group change only for the revision it claims', () => {
    const srv = serveGroup();
    const actions = toBinary(GroupChange_ActionsSchema, create(GroupChange_ActionsSchema, { sourceUserId: libsignal.groupEncryptServiceId(srv.keys.secretParams, BOB), version: 5 }));
    const signed = toBinary(GroupChangeSchema, create(GroupChangeSchema, { actions, serverSignature: randomBytes(64) }));
    assert.equal(groupChangeAuthor(srv.keys, signed, 5), BOB);
    assert.equal(groupChangeAuthor(srv.keys, signed, 6), '');
    assert.equal(groupChangeAuthor(srv.keys, new Uint8Array(0), 5), '');
    assert.equal(groupChangeAuthor(srv.keys, new Uint8Array([1, 2, 3]), 5), '');
  });
});

describe('Group update lines', () => {
  const base = {
    id: 'group.X',
    internal_id: 'X',
    masterKey: '',
    revision: 4,
    name: 'Before',
    description: '',
    members: [ALICE, BOB],
    admins: [ALICE],
    pending: [CAROL],
    requesting: [DAVE],
    expireTimer: 0,
    blocked: false,
    permissions: { add_members: 'every-member' as const, edit_group: 'only-admins' as const, send_messages: 'every-member' as const },
    link_mode: 'enabled-with-approval' as const,
    invite_link: 'https://signal.group/#a',
  };

  it('describes each change, crediting the author only when it is known', () => {
    const next = {
      ...base,
      revision: 5,
      name: 'After',
      expireTimer: 86400,
      members: [ALICE, BOB, DAVE, ERIN],
      admins: [ALICE, BOB],
      pending: [],
      requesting: [],
      permissions: { ...base.permissions, send_messages: 'only-admins' as const },
      invite_link: 'https://signal.group/#b',
    };
    assert.deepEqual(diffGroupState(base, next, ALICE, ALICE), [
      { change: 'title', text: 'After' },
      { change: 'timer', seconds: 86400 },
      { change: 'permSend', value: 'only-admins' },
      { change: 'linkReset' },
      { change: 'requestApproved', target: DAVE },
      { change: 'memberAdded', target: ERIN },
      { change: 'adminAdded', target: BOB },
      { change: 'inviteRemoved', count: 1 },
    ]);
    const left = diffGroupState(base, { ...base, revision: 5, members: [ALICE], pending: [], requesting: [] }, CAROL, ALICE);
    assert.deepEqual(left, [{ change: 'memberRemoved', target: BOB }, { change: 'inviteDeclined', target: CAROL }, { change: 'requestDenied', target: DAVE }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, members: [ALICE] }, BOB, ALICE), [{ change: 'left', target: BOB }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, members: [ALICE, BOB, ERIN] }, ERIN, ALICE), [{ change: 'joinedViaLink', target: ERIN }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, pending: [CAROL, ALICE, ERIN] }, '', ALICE), [
      { change: 'invited', target: ALICE, count: 1 },
      { change: 'invited', count: 1 },
    ]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, link_mode: 'disabled', invite_link: '' }, '', ALICE), [{ change: 'link', value: 'disabled', from: 'enabled-with-approval' }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5 }, ALICE, ALICE), []);
    assert.equal(isDecodedGroup({ id: 'group.X', name: 'Group', members: [BOB], admins: [] }), false);
    assert.equal(isDecodedGroup(base), true);
  });
});
