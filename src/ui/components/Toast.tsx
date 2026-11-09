import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

let current: { id: number; text: string } | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();

/** Show a short message that drops in from the top, KaiOS style. */
export function toast(text: string, ms = 2500): void {
  current = { id: nextId++, text };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    subs.forEach((f) => f());
  }, ms);
  subs.forEach((f) => f());
}

export function ToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  if (!current) return null;
  return (
    <div class="toast" key={current.id} role="status">
      {current.text}
    </div>
  );
}

/** A strip under the header for ongoing state, such as the connection. */
export function Banner(props: { tone?: 'info' | 'warn'; children: ComponentChildren }) {
  return <div class={'banner banner-' + (props.tone || 'info')}>{props.children}</div>;
}
