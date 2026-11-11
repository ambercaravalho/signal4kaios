import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useFocusScroll } from '../../app/focus';
import * as store from '../../data/store';
import { isJumboEmoji } from '../../data/styled';
import type { Message, Quote } from '../../data/types';
import { S } from '../../strings';
import { attachmentIcon } from '../attachment-icon';
import { Icon } from '../Icon';
import { RichText } from '../RichText';
import { AttachmentView } from './AttachmentView';
import { ContactCardView } from './ContactCardView';
import { LinkPreviewView } from './LinkPreviewView';
import { MessageMeta } from './MessageMeta';
import { PollView } from './PollView';
import { Reactions } from './Reactions';

export function authorName(m: Message): string {
  if (!m.incoming) return S.you;
  const known = store.displayName(m.author);
  return known !== m.author ? known : m.authorName || known;
}

function quoteAuthorName(author: string): string {
  return store.isSelf(author) ? S.you : store.displayName(author);
}

function quoteText(q: Quote): string {
  return q.text || store.attachmentLabel(q.attachments) || S.photo;
}

/** Whether the text overflows its clamp. Measured once per text so moving the time out of the text can't flip it back. */
function useClipped(ref: { current: HTMLElement | null }, text: string): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    setClipped(!!el && el.scrollHeight > el.clientHeight + 2);
  }, [text]);
  return clipped;
}

export function Bubble(props: { m: Message; focused: boolean; showAuthor: boolean; onClipped(id: string, clipped: boolean): void }) {
  const { m } = props;
  const ref = useFocusScroll<HTMLDivElement>(props.focused);
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = m.deleted ? (m.deletedByAdmin ? S.adminDeleted : S.deletedMessage) : m.body;
  const jumbo = !m.deleted && !m.attachments.length && !m.quote && isJumboEmoji(m.body);
  const clipped = useClipped(bodyRef, text || '');
  useEffect(() => props.onClipped(m.id, clipped), [clipped]);
  const attachments = m.deleted ? [] : m.attachments;
  const meta = <MessageMeta m={m} />;
  const preview = m.deleted ? undefined : m.preview;
  const metaInText = !!text && !jumbo && !clipped && !preview;
  const metaOnAttachment = !text && attachments.length > 0;
  const cls = 'msg ' + (m.incoming ? 'msg-in' : 'msg-out') + (props.focused ? ' focused' : '');
  const bubbleCls = 'bubble' + (jumbo ? ' bubble-jumbo' : '') + (m.deleted ? ' bubble-deleted' : '') + (m.status === 'failed' ? ' bubble-failed' : '');
  return (
    <div class={cls} ref={ref} role="listitem">
      <div class={bubbleCls}>
        {props.showAuthor && <div class="msg-author">{authorName(m)}</div>}
        {m.quote && !m.deleted && (
          <div class="msg-quote">
            <div class="msg-quote-author">{quoteAuthorName(m.quote.author)}</div>
            <div class="msg-quote-text">
              {m.quote.attachments && m.quote.attachments.length > 0 && <Icon name={attachmentIcon(m.quote.attachments[0])} />}
              {quoteText(m.quote).slice(0, 120)}
            </div>
          </div>
        )}
        {attachments.map((a, i) => (
          <AttachmentView key={a.id || i} att={a} meta={metaOnAttachment && i === attachments.length - 1 ? meta : null} />
        ))}
        {m.contactCard && !m.deleted && <ContactCardView card={m.contactCard} />}
        {m.poll && !m.deleted && <PollView poll={m.poll} />}
        {text && (
          <div class={'msg-body' + (jumbo ? ' jumbo' : '') + (clipped ? ' clipped' : '')} ref={bodyRef}>
            <RichText text={text} styles={m.deleted ? [] : m.styles} revealSpoilers={props.focused} />
            {metaInText && meta}
          </div>
        )}
        {clipped && <div class="msg-more">{S.readMore}</div>}
        {preview && <LinkPreviewView preview={preview} />}
        {!metaInText && !metaOnAttachment && <div class="msg-meta-line">{meta}</div>}
      </div>
      {!m.deleted && <Reactions reactions={m.reactions} />}
      {m.status === 'failed' && <div class="msg-failed">{S.notSent}</div>}
    </div>
  );
}
