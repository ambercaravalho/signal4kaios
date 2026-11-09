import { sha256 } from '@noble/hashes/sha2.js';
import { useEffect, useState } from 'preact/hooks';
import { fromBase64, uuidToBytes } from '../../engine/bytes';
import { signal } from '../data/api';
import { db } from '../data/db';
import { initials } from '../data/format';
import { contactByKey, isSelfConv } from '../data/store';
import type { Conversation } from '../data/types';
import { Icon } from './Icon';

/** What an avatar needs: a chat, or a person or group that has no chat yet. */
export type AvatarSubject = Pick<Conversation, 'id' | 'type' | 'name' | 'groupInternalId'>;

/** Signal's 12 avatar colors (Signal-Desktop AxoTokens.Avatar), as [background, text]. */
export const AVATAR_COLORS: Array<[string, string]> = [
  ['#e3e3fe', '#3838f5'],
  ['#dde7fc', '#1251d3'],
  ['#d8e8f0', '#086da0'],
  ['#cde4cd', '#067906'],
  ['#eae0fd', '#661aff'],
  ['#f5e3fe', '#9f00f0'],
  ['#f6d8ec', '#b8057c'],
  ['#f5d7d7', '#be0404'],
  ['#fef5d0', '#836b01'],
  ['#eae6d5', '#7d6f40'],
  ['#d2d2dc', '#4f4f6d'],
  ['#d7d7d9', '#5c5c5c'],
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const colorMemo: Record<string, number> = {};

/** Port of Signal-Desktop's `getIdentifierHash` / `generateAvatarColor` (ts/Crypto.node.ts): SHA-256 of the ACI's binary form, else the number's UTF-8, else the group ID's bytes; the first byte picks the color. */
export function avatarColorIndex(id: { aci?: string; e164?: string; groupId?: string }): number {
  const key = (id.aci || '') + '|' + (id.e164 || '') + '|' + (id.groupId || '');
  if (key in colorMemo) return colorMemo[key];
  let bytes: Uint8Array | null = null;
  try {
    if (id.aci && UUID_RE.test(id.aci)) bytes = uuidToBytes(id.aci);
    else if (id.e164) bytes = new TextEncoder().encode(id.e164);
    else if (id.groupId) bytes = fromBase64(id.groupId);
  } catch {
    bytes = null;
  }
  const idx = bytes && bytes.length ? sha256(bytes)[0] % AVATAR_COLORS.length : 0;
  colorMemo[key] = idx;
  return idx;
}

export function avatarColorFor(conv: Pick<Conversation, 'id' | 'type' | 'groupInternalId'>): number {
  if (conv.type === 'group') return avatarColorIndex({ groupId: conv.groupInternalId });
  const c = contactByKey(conv.id);
  const aci = (c && c.uuid) || (UUID_RE.test(conv.id) ? conv.id : '');
  return avatarColorIndex({ aci, e164: aci ? undefined : (c && c.number) || conv.id });
}

/* Object URLs per chat for this session; null means "known to have no photo". */
const photoUrl: Record<string, string | null> = {};
const pending: Record<string, Promise<string | null>> = {};

function ensureImage(blob: Blob | undefined): Blob {
  if (!blob || !blob.size || (blob.type || '').indexOf('image/') !== 0) throw new Error('not an image');
  return blob;
}

function fetchPhoto(conv: AvatarSubject): Promise<Blob> {
  if (conv.type === 'group') return Promise.reject(new Error('no photo'));
  const c = contactByKey(conv.id);
  if (!c || c.hasAvatar === false || !c.uuid) return Promise.reject(new Error('no photo'));
  return signal.fetchContactAvatarBlob(c.uuid).then(ensureImage);
}

function loadPhoto(conv: AvatarSubject): Promise<string | null> {
  if (conv.id in photoUrl) return Promise.resolve(photoUrl[conv.id]);
  if (!pending[conv.id]) {
    const key = 'avatar:' + conv.id;
    pending[conv.id] = db
      .getAttachment(key)
      .then((row) => {
        if (row && row.blob && row.blob.size) return URL.createObjectURL(row.blob);
        return fetchPhoto(conv).then((blob) => {
          db.putAttachment(key, blob, blob.type);
          return URL.createObjectURL(blob);
        });
      })
      .catch(() => null)
      .then((url) => {
        photoUrl[conv.id] = url;
        return url;
      });
  }
  return pending[conv.id];
}

/** A round avatar: the profile or group photo when there is one, otherwise initials on the person's Signal color. */
export function Avatar(props: { conv: AvatarSubject; size?: 'md' | 'lg' }) {
  const { conv } = props;
  const self = isSelfConv(conv);
  const [url, setUrl] = useState<string | null>(photoUrl[conv.id] || null);
  useEffect(() => {
    if (self) return;
    let live = true;
    loadPhoto(conv).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [conv.id, self]);

  const [bg, fg] = AVATAR_COLORS[avatarColorFor(conv)];
  const cls = 'avatar' + (props.size === 'lg' ? ' avatar-lg' : '');
  if (self)
    return (
      <div class={cls} style={{ background: AVATAR_COLORS[0][0], color: AVATAR_COLORS[0][1] }}>
        <Icon name="note" />
      </div>
    );
  return (
    <div class={cls} style={{ background: bg, color: fg }}>
      {url ? <img class="avatar-img" src={url} alt="" /> : conv.type === 'group' && !conv.name ? <Icon name="group" /> : initials(conv.name)}
    </div>
  );
}
