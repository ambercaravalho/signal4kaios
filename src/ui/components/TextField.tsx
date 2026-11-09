import { useLayoutEffect, useRef } from 'preact/hooks';
import { useFocusScroll } from '../app/focus';
import { useIsTop } from '../app/router';

export interface TextFieldProps {
  focused: boolean;
  value: string;
  onInput(v: string): void;
  label?: string;
  placeholder?: string;
  type?: 'text' | 'tel' | 'number';
  maxLength?: number;
  multiline?: boolean;
  /** Grow up to this many lines before scrolling. */
  maxLines?: number;
  inputRef?: { current: HTMLInputElement | HTMLTextAreaElement | null };
}

/** A KaiOS text field. It holds DOM focus while focused so the keypad types into it; Back deletes while it has text. */
export function TextField(p: TextFieldProps) {
  const wrap = useFocusScroll<HTMLDivElement>(p.focused);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const top = useIsTop();
  const active = p.focused && top;

  useLayoutEffect(() => {
    if (p.inputRef) p.inputRef.current = input.current;
  });

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    if (active) {
      if (document.activeElement !== el) {
        el.focus();
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          // number inputs have no selection
        }
      }
    } else if (document.activeElement === el) {
      el.blur();
    }
  }, [active]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !p.multiline) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || 22;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = el.offsetHeight - el.clientHeight;
    const max = (p.maxLines || 4) * lineH + padY + borderY;
    const want = Math.max(el.scrollHeight, lineH + padY) + borderY;
    el.style.height = Math.min(want, max) + 'px';
    el.style.overflowY = want > max ? 'auto' : 'hidden';
  }, [p.value, p.multiline, p.focused]);

  const common = {
    ref: input,
    class: 'tf-input',
    value: p.value,
    placeholder: p.placeholder,
    maxLength: p.maxLength,
    onInput: (e: Event) => p.onInput((e.currentTarget as HTMLInputElement).value),
  };
  return (
    <div class={'tf' + (p.focused ? ' focused' : '')} ref={wrap}>
      {p.label && <div class="tf-label">{p.label}</div>}
      {p.multiline ? <textarea {...common} rows={1} /> : <input {...common} type={(p.type || 'text') as 'text'} />}
    </div>
  );
}
