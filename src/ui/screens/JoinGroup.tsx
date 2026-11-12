import { useEffect, useRef, useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { Avatar } from '../components/Avatar';
import { EmptyState, Spinner } from '../components/List';
import { confirm } from '../components/Overlays';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { signal } from '../data/api';
import * as store from '../data/store';
import { friendlyError } from '../errors';
import { S } from '../strings';
import { ChatScreen } from './Chat';

type LinkInfo = Awaited<ReturnType<typeof signal.groupLinkInfo>>;

/** A group someone shared a link to: its name, size, and description, with Join, Request to join, or Cancel request. */
export function JoinGroupScreen(props: { url: string }) {
  const [info, setInfo] = useState<LinkInfo | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const load = () => {
    signal.groupLinkInfo(props.url).then(
      (res) => {
        if (res.member) router.replace(ChatScreen, { convId: store.groupConversation(res.internalId).id });
        else setInfo(res);
      },
      (e) => {
        setError(friendlyError(e));
        setInfo(null);
      }
    );
  };
  useEffect(load, [props.url]);

  async function act(): Promise<void> {
    if (!info || busy) return;
    if (info.pending && !(await confirm({ title: S.cancelRequest, body: S.cancelRequestConfirm, ok: S.cancelRequest, danger: true }))) return;
    setBusy(true);
    try {
      if (info.pending) {
        await signal.cancelGroupLinkRequest(props.url);
        toast(S.joinRequestCanceled);
        setInfo({ ...info, pending: false });
        return;
      }
      const res = await signal.joinGroupLink(props.url);
      if (res.joined) {
        router.replace(ChatScreen, { convId: store.joinedGroupConversation(res.internalId, res.name || info.title).id });
        return;
      }
      toast(S.joinRequestSent);
      setInfo({ ...info, pending: true });
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const label = !info || busy ? null : info.pending ? S.cancelRequest : info.approvalRequired ? S.requestToJoin : S.join;
  useSoftkeys({ center: label });
  useKeys((e) => {
    if (e.key === 'Enter' && label) act();
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && body.current) body.current.scrollTop += e.key === 'ArrowDown' ? 40 : -40;
    else return false;
    return true;
  });

  let content;
  if (info === undefined || busy) content = <Spinner />;
  else if (!info) content = <EmptyState title={S.joinGroup} body={error || S.groupLinkInvalid} />;
  else {
    const name = info.title || S.group;
    const count = info.memberCount + ' ' + (info.memberCount === 1 ? S.memberOne : S.memberMany);
    const hint = info.pending ? S.joinPendingHint : info.approvalRequired ? S.joinApprovalHint : S.joinGroupHint;
    content = (
      <>
        <div class="profile-head">
          <Avatar conv={{ id: 'g:' + info.internalId, type: 'group', name, groupInternalId: info.internalId }} size="lg" />
          <div class="profile-name">{name}</div>
          <div class="profile-sub">{count}</div>
        </div>
        {info.description && <div class="details-text">{info.description}</div>}
        <div class="safety-hint">{hint}</div>
      </>
    );
  }

  return (
    <Screen title={S.joinGroup}>
      <div class="safety" ref={body}>
        {content}
      </div>
    </Screen>
  );
}
