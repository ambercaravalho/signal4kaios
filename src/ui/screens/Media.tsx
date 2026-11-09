import { useEffect, useState } from 'preact/hooks';
import { router } from '../app/router';
import { Icon } from '../components/Icon';
import { EmptyState, Spinner } from '../components/List';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { cachedAttachment, isImage } from '../data/attachments';
import { config } from '../data/config';
import { fmtTime } from '../data/format';
import * as store from '../data/store';
import type { Attachment, Message } from '../data/types';
import { S } from '../strings';
import { attachmentIcon } from './Chat';
import { ViewerScreen } from './Viewer';

/** A downloaded photo as a small square; anything else as its type icon. */
function Thumb(props: { att: Attachment }) {
  const { att } = props;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage(att)) return;
    let live = true;
    let obj: string | null = null;
    cachedAttachment(att).then((b) => {
      if (!live || !b) return;
      obj = URL.createObjectURL(b);
      setUrl(obj);
    });
    return () => {
      live = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [att.id]);
  return <span class="media-thumb">{url ? <img class="media-thumb-img" src={url} alt="" /> : <Icon name={attachmentIcon(att)} />}</span>;
}

function senderName(m: Message): string {
  return !m.incoming || m.author === store.selfNumber() || m.author === config.aci() ? S.you : store.displayName(m.author);
}

/** A chat's photos, videos, voice messages, and files, newest first. OK opens one in the viewer. */
export function MediaScreen(props: { convId: string }) {
  const [items, setItems] = useState<Array<{ msg: Message; att: Attachment }> | null>(null);
  useEffect(() => {
    let live = true;
    store.chatMedia(props.convId).then(
      (list) => live && setItems(list),
      () => live && setItems([])
    );
    return () => {
      live = false;
    };
  }, [props.convId]);

  const rows: Row[] = (items || []).map(({ msg, att }, i) => ({
    key: msg.id + ':' + i,
    label: store.attachmentLabel([att]),
    sub: senderName(msg) + ' · ' + fmtTime(msg.timestamp),
    leading: <Thumb att={att} />,
    action: S.open,
    onSelect: () => router.push(ViewerScreen, { att, title: senderName(msg), onOpened: () => store.markViewed(msg) }),
  }));
  return (
    <Screen title={S.media}>
      <RowList rows={rows} empty={items ? <EmptyState title={S.noMedia} /> : <Spinner />} />
    </Screen>
  );
}
