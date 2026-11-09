import { useEffect, useRef, useState } from 'preact/hooks';
import { useKeys, useSoftkeys } from '../app/router';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/List';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { fileNameFor, loadAttachment, NotDownloadableError, storageKindFor, ViewedOnceError } from '../data/attachments';
import { fmtBytes } from '../data/format';
import { dbg } from '../data/log';
import { saveToDevice } from '../data/platform';
import { attachmentLabel } from '../data/store';
import type { Attachment } from '../data/types';
import { friendlyError } from '../errors';
import { S } from '../strings';

/** A photo, video, voice message, or file from a message. OK plays and pauses; the right softkey saves it to the phone. */
export function ViewerScreen(props: { att: Attachment; title: string }) {
  const { att } = props;
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let obj: string | null = null;
    loadAttachment(att).then(
      (b) => {
        if (!live) return;
        obj = URL.createObjectURL(b);
        setBlob(b);
        setUrl(obj);
      },
      (e) => {
        if (!live) return;
        if (e instanceof ViewedOnceError) setError(S.alreadyViewed);
        else if (e instanceof NotDownloadableError) setError(S.sentFromThisPhone);
        else setError(friendlyError(e, S.attachmentFailed));
      }
    );
    return () => {
      live = false;
      if (media.current) media.current.pause();
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [att.id]);

  const type = (blob && blob.type) || att.contentType || '';
  const isAudio = type.indexOf('audio/') === 0 || !!att.voiceNote;
  const isVideo = type.indexOf('video/') === 0;
  const isImg = type.indexOf('image/') === 0;
  const playable = !!url && (isAudio || isVideo);

  useEffect(() => {
    const el = media.current;
    if (!el) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    el.addEventListener('play', on);
    el.addEventListener('pause', off);
    el.addEventListener('ended', off);
    return () => {
      el.removeEventListener('play', on);
      el.removeEventListener('pause', off);
      el.removeEventListener('ended', off);
    };
  }, [url]);

  function save(): void {
    if (!blob || att.viewOnce) return;
    saveToDevice(storageKindFor(type), blob, fileNameFor(att, type)).then(
      () => toast(S.savedToPhone),
      (e) => {
        dbg('save failed: ' + (e && e.name));
        toast(e && e.name === 'NoModificationAllowedError' ? S.fileExists : S.saveFailed);
      }
    );
  }

  useSoftkeys({ center: playable ? (playing ? S.pause : S.play) : null, right: blob && !att.viewOnce ? S.saveToPhone : null });
  useKeys((e) => {
    if (e.key === 'Enter' && playable && media.current) {
      if (media.current.paused) media.current.play().catch(() => {});
      else media.current.pause();
      return true;
    }
    if (e.key === 'SoftRight') {
      save();
      return true;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && bodyRef.current) {
      bodyRef.current.scrollTop += e.key === 'ArrowDown' ? 40 : -40;
      return true;
    }
    return false;
  });

  let content;
  if (error) content = <div class="viewer-note">{error}</div>;
  else if (!url) content = <Spinner label={S.downloading} />;
  else if (isImg) content = <img class="viewer-img" src={url} alt="" />;
  else if (isVideo) content = <video class="viewer-video" src={url} ref={(el) => {
          media.current = el;
        }} />;
  else
    content = (
      <div class="viewer-file">
        <Icon name={isAudio ? 'mic' : 'file'} />
        <div class="viewer-file-name">{isAudio ? attachmentLabel([att]) : att.filename || S.file}</div>
        <div class="viewer-file-size">{fmtBytes(blob ? blob.size : att.size)}</div>
        {isAudio && <audio src={url} ref={(el) => {
          media.current = el;
        }} />}
      </div>
    );

  return (
    <Screen title={props.title}>
      <div class="viewer" ref={bodyRef}>
        {content}
      </div>
    </Screen>
  );
}
