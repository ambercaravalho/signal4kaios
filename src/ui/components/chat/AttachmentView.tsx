import type { VNode } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useObjectUrl } from '../../app/hooks';
import { autoDownloads, cachedAttachment, isImage, loadAttachment } from '../../data/attachments';
import { blurHashUrl } from '../../data/blurhash';
import { fmtBytes, fmtLength } from '../../data/format';
import * as store from '../../data/store';
import type { Attachment } from '../../data/types';
import { waveformBars } from '../../data/voice-recorder';
import { S } from '../../strings';
import { attachmentIcon } from '../attachment-icon';
import { Icon } from '../Icon';

const VOICE_BARS = 32;

/** An inline photo once it's downloaded; anything else is a labelled row that opens in the viewer. `meta` sits over the photo's corner, or below a file row. */
export function AttachmentView(props: { att: Attachment; meta?: VNode | null; photoOnly?: boolean }) {
  const { att } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [url, showBlob] = useObjectUrl(att.id);
  useEffect(() => {
    if (!isImage(att) || att.viewOnce || !att.id) return;
    let live = true;
    let io: IntersectionObserver | null = null;
    const show = (b: Blob | null) => {
      if (live && b) showBlob(b);
    };
    cachedAttachment(att).then((b) => {
      if (b) return show(b);
      if (!autoDownloads(att) || !live) return;
      const start = () => loadAttachment(att).then(show, () => {});
      const el = ref.current;
      if (el && typeof IntersectionObserver !== 'undefined') {
        io = new IntersectionObserver(
          (entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            if (io) io.disconnect();
            start();
          },
          { rootMargin: '200px' }
        );
        io.observe(el);
      } else start();
    });
    return () => {
      live = false;
      if (io) io.disconnect();
    };
  }, [att.id]);
  if (url)
    return (
      <div class="msg-media" ref={ref}>
        <img src={url} alt="" />
        {props.meta}
      </div>
    );
  const placeholder = !att.viewOnce && att.blurHash && (isImage(att) || (att.contentType || '').indexOf('video/') === 0) ? blurHashUrl(att.blurHash, att.width, att.height) : null;
  if (placeholder)
    return (
      <div class="msg-media msg-media-blur" ref={ref}>
        <img src={placeholder} alt="" />
        {!isImage(att) && <Icon name="play" class="msg-media-play" />}
        {props.meta}
      </div>
    );
  if (props.photoOnly) return <div ref={ref} />;
  if (!att.viewOnce && (att.contentType || '').indexOf('audio/') === 0 && (att.waveform || att.duration))
    return (
      <>
        <div class="msg-file msg-voice" ref={ref}>
          <Icon name="mic" />
          <span class="msg-wave">
            {waveformBars(att.waveform || [], VOICE_BARS).map((v, i) => (
              <span key={i} class="msg-wave-bar" style={{ height: Math.max(10, Math.round(v * 100)) + '%' }} />
            ))}
          </span>
          {att.duration ? <span class="msg-file-size">{fmtLength(att.duration)}</span> : null}
        </div>
        {props.meta}
      </>
    );
  return (
    <>
      <div class="msg-file" ref={ref}>
        <Icon name={attachmentIcon(att)} />
        <span class="msg-file-name">{att.viewOnce ? S.viewOnceMedia : store.attachmentLabel([att])}</span>
        {!att.viewOnce && att.size ? <span class="msg-file-size">{fmtBytes(att.size)}</span> : null}
      </div>
      {props.meta}
    </>
  );
}
