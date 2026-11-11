import { useEffect, useState } from 'preact/hooks';
import { useRefresh } from '../../app/hooks';
import { router } from '../../app/router';
import { Avatar, OWN_PROFILE_PREFIX } from '../../components/Avatar';
import { pickEmoji } from '../../components/Emoji';
import { confirm, prompt, showOptions } from '../../components/Overlays';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toast } from '../../components/Toast';
import { signal, updateProfile } from '../../data/api';
import { config } from '../../data/config';
import { scaleToJpeg, squareGeometry } from '../../data/image-scale';
import { loadOwnPhoto, ownPhotoChanged } from '../../data/own-photo';
import { chooseFile } from '../../data/platform';
import * as store from '../../data/store';
import { friendlyError } from '../../errors';
import { S } from '../../strings';
import { QrScreen } from '../QrScreen';

const PROFILE_PHOTO_EDGE = 512;

export function selfName(): string {
  const cached = config.profileName();
  if (cached) return cached;
  const me = store.contactByKey(config.number());
  return me && me.name && me.name !== config.number() && me.name !== store.SELF_NAME ? me.name : '';
}

/** Save the profile, always with a name: Signal rejects a profile without one. */
async function saveProfile(patch: { name?: string; about?: string; emoji?: string }): Promise<void> {
  const name = (patch.name != null ? patch.name : selfName()).trim();
  if (!name) {
    toast(S.nameRequired);
    return;
  }
  const body: { name: string; about?: string; emoji?: string } = { name };
  if (patch.about != null) body.about = patch.about;
  else if (config.profileAbout()) body.about = config.profileAbout();
  if (patch.emoji != null) body.emoji = patch.emoji;
  try {
    await updateProfile(body);
    toast(S.saved);
  } catch (e) {
    toast(friendlyError(e));
  }
}

export function ProfileScreen() {
  const refresh = useRefresh();
  const name = selfName();
  const about = config.profileAbout();
  const emoji = config.profileAboutEmoji();
  const uname = config.username();
  const [hasPhoto, setHasPhoto] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  useEffect(() => {
    let live = true;
    loadOwnPhoto().then((url) => live && setHasPhoto(!!url));
    return () => {
      live = false;
    };
  }, []);

  async function chooseEmoji(): Promise<void> {
    const e = await pickEmoji(S.aboutEmoji);
    if (e) saveProfile({ emoji: e }).then(refresh);
  }

  function editEmoji(): void {
    if (!emoji) {
      chooseEmoji();
      return;
    }
    showOptions([
      { label: S.chooseEmoji, onSelect: chooseEmoji },
      { label: S.remove, danger: true, onSelect: () => saveProfile({ emoji: '' }).then(refresh) },
    ]);
  }

  async function editName(): Promise<void> {
    const v = await prompt({ title: S.yourName, value: name, maxLength: 26 });
    if (v) saveProfile({ name: v }).then(refresh);
  }

  async function editAbout(): Promise<void> {
    const v = await prompt({ title: S.about, value: about, maxLength: 140, allowEmpty: true });
    if (v !== undefined) saveProfile({ about: v }).then(refresh);
  }

  async function editUsername(): Promise<boolean> {
    const v = await prompt({ title: S.username, value: uname, hint: S.usernameHint, maxLength: 40 });
    if (!v) return false;
    try {
      const res = await signal.setUsername(v.replace(/^@/, ''));
      toast('@' + res.username);
      refresh();
      return true;
    } catch (e) {
      toast(friendlyError(e, S.usernameTaken));
      return false;
    }
  }

  async function showQr(): Promise<void> {
    if (!config.usernameLink() && !(await editUsername())) return;
    router.push(QrScreen, { title: S.usernameLink, text: config.usernameLink(), caption: '@' + config.username() });
  }

  async function deleteUsername(): Promise<void> {
    if (!(await confirm({ title: S.deleteUsername + '?', body: S.deleteUsernameBody, ok: S.delete, danger: true }))) return;
    signal.deleteUsername().then(
      () => {
        config.set({ username: '', usernameLink: '' });
        toast(S.saved);
        refresh();
      },
      (e) => toast(friendlyError(e))
    );
  }

  async function savePhoto(jpeg: Uint8Array | null): Promise<void> {
    setSavingPhoto(true);
    try {
      await signal.setOwnAvatar(jpeg);
      ownPhotoChanged();
      setHasPhoto(!!jpeg);
      toast(jpeg ? S.photoSaved : S.photoRemoved);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setSavingPhoto(false);
    }
  }

  async function choosePhoto(): Promise<void> {
    const file = await chooseFile('image/*');
    if (!file) return;
    let jpeg: Uint8Array;
    try {
      jpeg = await scaleToJpeg(file, (w, h) => squareGeometry(w, h, PROFILE_PHOTO_EDGE), 0.85);
    } catch {
      toast(S.photoUnreadable);
      return;
    }
    await savePhoto(jpeg);
  }

  function editPhoto(): void {
    if (savingPhoto) return;
    if (!hasPhoto) {
      choosePhoto();
      return;
    }
    showOptions([
      { label: S.choosePhoto, onSelect: choosePhoto },
      { label: S.removePhoto, danger: true, onSelect: () => savePhoto(null) },
    ]);
  }

  const self = { id: OWN_PROFILE_PREFIX + config.number(), type: 'direct' as const, name: name || config.number() };
  const rows: Row[] = [
    { key: 'photo', label: S.photo, sub: savingPhoto ? S.savingPhoto : hasPhoto ? undefined : S.usernameNone, leading: <Avatar conv={self} />, onSelect: editPhoto },
    { key: 'name', label: S.yourName, sub: name || S.usernameNone, onSelect: editName },
    { key: 'about', label: S.about, sub: about || S.usernameNone, onSelect: editAbout },
    { key: 'emoji', label: S.aboutEmoji, sub: emoji || S.usernameNone, onSelect: editEmoji },
    { key: 'user', label: S.username, sub: uname ? '@' + uname : S.usernameNone, onSelect: editUsername },
    { key: 'qr', label: S.usernameLink, onSelect: showQr },
    !!uname && { key: 'del', label: S.deleteUsername, danger: true, onSelect: deleteUsername },
  ];
  return (
    <Screen title={S.profile}>
      <RowList rows={rows} />
    </Screen>
  );
}
