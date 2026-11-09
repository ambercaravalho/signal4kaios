/* Signal-Desktop's poll limits (ts/types/Polls.dom.ts): we send questions of up to 100 characters but accept up to 200, with 2 to 10 options of up to 100 characters each. */

export const POLL_QUESTION_MAX_SEND = 100;
export const POLL_QUESTION_MAX_RECEIVE = 200;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;
/** Desktop's MAX_MESSAGE_BODY_BYTE_LENGTH, which also bounds each poll question and option. */
const MAX_BODY_BYTES = 2048;

/** Approximate user-visible characters without Intl.Segmenter (missing on Gecko 84): joiners, variation selectors, skin tones, combining marks, and the code point after a joiner don't count. */
export function graphemeCount(s: string): number {
  let n = 0;
  let joined = false;
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d) {
      joined = true;
      continue;
    }
    const extender = (cp >= 0x300 && cp <= 0x36f) || cp === 0xfe0e || cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f);
    if (!extender && !joined) n += 1;
    joined = false;
  }
  return n;
}

function fits(s: string, maxGraphemes: number): boolean {
  return !!s && graphemeCount(s) <= maxGraphemes && new TextEncoder().encode(s).length <= MAX_BODY_BYTES;
}

/** Whether a poll's question and options are within Signal's limits. */
export function validPoll(question: string, options: readonly string[], questionMax: number): boolean {
  return fits(question, questionMax) && options.length >= POLL_OPTIONS_MIN && options.length <= POLL_OPTIONS_MAX && options.every((o) => fits(o, POLL_OPTION_MAX));
}
