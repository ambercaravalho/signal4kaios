import { emojiRuns, linkRuns, StyleRange, styleSegments } from '../data/styled';

const STYLE_CLASS: Record<string, string> = { BOLD: 'fmt-b', ITALIC: 'fmt-i', STRIKETHROUGH: 'fmt-st', MONOSPACE: 'fmt-mono', SPOILER: 'fmt-spoiler' };

function Emojified(props: { text: string }) {
  return (
    <>
      {emojiRuns(props.text).map((r, i) =>
        r.emoji ? (
          <span key={i} class="emoji">
            {r.text}
          </span>
        ) : (
          r.text
        )
      )}
    </>
  );
}

/** Message text with Signal formatting, larger emoji, and underlined links (opened from the message's options). Spoilers stay hidden until `revealSpoilers`. */
export function RichText(props: { text: string; styles?: StyleRange[]; revealSpoilers?: boolean }) {
  return (
    <>
      {styleSegments(props.text || '', props.styles).map((seg, i) => {
        const cls = seg.styles.map((s) => STYLE_CLASS[s]).join(' ') + (props.revealSpoilers ? ' revealed' : '');
        const inner = linkRuns(seg.text).map((r, j) =>
          r.url ? (
            <span key={j} class="link">
              <Emojified text={r.text} />
            </span>
          ) : (
            <Emojified key={j} text={r.text} />
          )
        );
        return seg.styles.length ? (
          <span key={i} class={cls}>
            {inner}
          </span>
        ) : (
          <span key={i}>{inner}</span>
        );
      })}
    </>
  );
}

/** One line of plain text with emoji, for list rows and previews. */
export function EmojiText(props: { text: string }) {
  return <Emojified text={props.text} />;
}
