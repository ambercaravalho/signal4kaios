import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';
import * as zk from '@signalapp/libsignal-client/zkgroup';

import { fromHex, randomBytes, toBase64, toHex, toWebSafeBase64 } from '../src/engine/bytes';
import {
  AccessControl_AccessRequired,
  GroupAttributeBlobSchema,
  GroupChange_ActionsSchema,
  GroupChangeResponseSchema,
  GroupChangeSchema,
  GroupJoinInfoSchema,
  GroupResponseSchema,
  GroupSchema,
  Member_Role,
  MemberPendingAdminApprovalSchema,
  MemberSchema,
} from '../src/engine/gen/Groups_pb';
import { cancelGroupJoinRequest, fetchGroupJoinInfo, joinGroupViaLink } from '../src/engine/services/group-changes';
import { decodeGroupState, deriveGroupV2Keys, groupInviteLink, parseGroupLink } from '../src/engine/services/groups-v2';
import { libsignal } from '../src/engine/protocol/libsignal';
import { create, fromBinary, toBinary } from '../src/engine/net/proto';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { ALICE, BOB, CAROL } from './helpers';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

describe('Joining through a group link', () => {
  const PNI = '99999999-9999-4999-8999-999999999999';

  /** A storage server with Bob's group behind a link; Alice (us) is not in it yet. */
  function serveLinkGroup(approval: boolean) {
    const serverSecret = zk.ServerSecretParams.generate();
    const serverPublic = new Uint8Array(serverSecret.getPublicParams().serialize());
    const masterKey = randomBytes(32);
    const password = randomBytes(16);
    const keys = deriveGroupV2Keys(masterKey);
    const enc = (id: string) => libsignal.groupEncryptServiceId(keys.secretParams, id);
    const blob = (content: any) => libsignal.groupEncryptBlob(keys.secretParams, toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content })), 0);
    const group = create(GroupSchema, {
      version: 9,
      title: blob({ case: 'title', value: 'Hikers' }),
      description: blob({ case: 'descriptionText', value: 'Weekend walks' }),
      inviteLinkPassword: password,
      accessControl: { attributes: AccessControl_AccessRequired.MEMBER, members: AccessControl_AccessRequired.MEMBER, addFromInviteLink: approval ? AccessControl_AccessRequired.ADMINISTRATOR : AccessControl_AccessRequired.ANY },
      members: [
        { userId: enc(BOB), role: Member_Role.ADMINISTRATOR },
        { userId: enc(CAROL), role: Member_Role.DEFAULT },
      ],
    });
    const today = Math.floor(Date.now() / 86400000) * 86400;
    const credential = new zk.ServerZkAuthOperations(serverSecret).issueAuthCredentialWithPniZkc(official.Aci.fromUuid(ALICE), official.Pni.fromUuid(PNI), today);
    const httpJson = async () => ({ credentials: [{ credential: toBase64(credential.serialize()), redemptionTime: today }] });

    const isAlice = (userId: Uint8Array) => libsignal.groupDecryptServiceId(keys.secretParams, userId) === ALICE;
    const presentation = new Uint8Array([4, 5, 6]);
    const calls: string[] = [];
    let respond: number[] = [];
    const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
      calls.push(method + ' ' + url.replace('https://storage.signal.org', ''));
      const [publicHex, presentationHex] = atob(headers!.Authorization.replace(/^Basic /, '')).split(':');
      assert.equal(publicHex, toHex(keys.publicParams));
      new zk.ServerZkAuthOperations(serverSecret).verifyAuthCredentialPresentation(
        new zk.GroupPublicParams(new Uint8Array(keys.publicParams)),
        new zk.AuthCredentialPresentation(new Uint8Array(fromHex(presentationHex)))
      );
      const pending = group.membersPendingAdminApproval.some((p) => isAlice(p.userId));
      const linkOk = (pw: string) => pw === toWebSafeBase64(password);
      const join = /\/v2\/groups\/join\/(.*)$/.exec(url);
      if (method === 'GET' && join) {
        if (!(join[1] ? linkOk(join[1]) : pending)) throw Object.assign(new Error('HTTP 403'), { status: 403 });
        return toBinary(
          GroupJoinInfoSchema,
          create(GroupJoinInfoSchema, {
            publicKey: keys.publicParams,
            title: group.title,
            description: group.description,
            memberCount: group.members.length,
            addFromInviteLink: group.accessControl!.addFromInviteLink,
            version: group.version,
            pendingAdminApproval: pending,
          })
        );
      }
      if (method === 'GET') {
        if (!group.members.some((m) => isAlice(m.userId))) throw Object.assign(new Error('HTTP 403'), { status: 403 });
        return toBinary(GroupResponseSchema, create(GroupResponseSchema, { group }));
      }
      assert.equal(method, 'PATCH');
      const query = /\/v2\/groups\/\?inviteLinkPassword=(.+)$/.exec(url);
      assert.ok(query && linkOk(query[1]), 'the link password goes with the change');
      const status = respond.shift();
      if (status) {
        if (status === 409) group.version++;
        throw Object.assign(new Error('HTTP ' + status), { status });
      }
      const actions = fromBinary(GroupChange_ActionsSchema, body!);
      assert.equal(actions.version, group.version + 1);
      for (const a of actions.addMembers) {
        assert.deepEqual(a.added!.presentation, presentation);
        group.members.push(create(MemberSchema, { userId: enc(ALICE), role: a.added!.role }));
      }
      for (const a of actions.addMembersPendingAdminApproval) {
        assert.deepEqual(a.added!.presentation, presentation);
        group.membersPendingAdminApproval.push(create(MemberPendingAdminApprovalSchema, { userId: enc(ALICE) }));
      }
      const withdrawn = actions.deleteMembersPendingAdminApproval.map((d) => toBase64(d.deletedUserId));
      group.membersPendingAdminApproval = group.membersPendingAdminApproval.filter((p) => !withdrawn.includes(toBase64(p.userId)));
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
    return { deps, masterKey, password, keys, group, presentation, calls, link: groupInviteLink(masterKey, password), respondWith: (s: number[]) => { respond = s; } };
  }

  it('reads the master key and password back out of a group link', () => {
    const masterKey = randomBytes(32);
    const password = randomBytes(16);
    const link = groupInviteLink(masterKey, password);
    for (const url of [link, link.replace('https://', 'sgnl://'), '  ' + link + '\n']) {
      const parsed = parseGroupLink(url);
      assert.ok(parsed);
      assert.deepEqual(parsed.masterKey, masterKey);
      assert.deepEqual(parsed.password, password);
    }
    for (const bad of ['https://signal.group/', 'https://signal.group/#', 'https://evil.example/#' + link.split('#')[1], 'https://signal.group/#AAAA', link + '/x']) {
      assert.equal(parseGroupLink(bad), null, bad);
    }
  });

  it('shows the group behind a link with the link password', async () => {
    const srv = serveLinkGroup(true);
    const info = await fetchGroupJoinInfo(srv.deps, srv.masterKey, srv.password);
    assert.deepEqual(info, { title: 'Hikers', description: 'Weekend walks', memberCount: 2, revision: 9, approvalRequired: true, pending: false });
    assert.deepEqual(srv.calls, ['GET /v2/groups/join/' + toWebSafeBase64(srv.password)]);
    await assert.rejects(fetchGroupJoinInfo(srv.deps, srv.masterKey, randomBytes(16)), (e: any) => e.name === 'GroupLinkInvalid');
    srv.group.accessControl!.addFromInviteLink = AccessControl_AccessRequired.UNSATISFIABLE;
    await assert.rejects(fetchGroupJoinInfo(srv.deps, srv.masterKey, srv.password), (e: any) => e.name === 'GroupLinkInvalid');
  });

  it('joins straight in with addMembers when the link needs no approval', async () => {
    const srv = serveLinkGroup(false);
    const res = await joinGroupViaLink(srv.deps, srv.masterKey, srv.password, srv.presentation);
    assert.equal(res.joined, true);
    assert.equal(res.revision, 10);
    assert.equal(fromBinary(GroupChange_ActionsSchema, fromBinary(GroupChangeSchema, res.groupChange).actions).version, 10);
    const state = decodeGroupState(srv.keys, srv.group);
    assert.deepEqual(state.members.sort(), [ALICE, BOB, CAROL].sort());
    assert.ok(!state.admins.includes(ALICE));
  });

  it('asks to join with addMembersPendingAdminApproval, retries after a 409, and cancels the request', async () => {
    const srv = serveLinkGroup(true);
    srv.respondWith([409]);
    const res = await joinGroupViaLink(srv.deps, srv.masterKey, srv.password, srv.presentation);
    assert.equal(res.joined, false);
    assert.equal(res.revision, 11);
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).requesting, [ALICE]);
    assert.equal(srv.calls.filter((c) => c.startsWith('PATCH')).length, 2);

    const again = await joinGroupViaLink(srv.deps, srv.masterKey, srv.password, srv.presentation);
    assert.equal(again.joined, false);
    assert.equal(again.groupChange.length, 0, 'an existing request is not sent twice');
    assert.equal((await fetchGroupJoinInfo(srv.deps, srv.masterKey)).pending, true, 'a pending request reads without the password');

    srv.calls.length = 0;
    assert.equal(await cancelGroupJoinRequest(srv.deps, srv.masterKey, srv.password), 12);
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).requesting, []);
    assert.deepEqual(srv.calls.map((c) => c.split('?')[0]), ['GET /v2/groups/join/' + toWebSafeBase64(srv.password), 'PATCH /v2/groups/']);
    assert.equal(await cancelGroupJoinRequest(srv.deps, srv.masterKey, srv.password), 12, 'nothing to cancel any more');
  });
});
