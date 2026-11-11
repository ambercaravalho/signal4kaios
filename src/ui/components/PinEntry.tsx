/* PIN entry straight from the keypad's digit keys, shown as dots. No text field is focused, so the phone's keyboard never sees or learns the digits. */

import { useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { PIN_MAX, PIN_MIN } from '../data/screen-lock';
import { S } from '../strings';

export function isDigitKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && e.key >= '0' && e.key <= '9';
}

export function PinDots(props: { length: number }) {
  const dots = [];
  for (let i = 0; i < props.length; i++) dots.push(<span key={i} class="pin-dot" />);
  return <div class="pin-dots">{dots}</div>;
}

function PinPromptView(props: { title: string; hint?: string; resolve(v: string | undefined): void }) {
  const [pin, setPin] = useState('');
  const finish = (v: string | undefined) => {
    router.pop();
    props.resolve(v);
  };
  const ready = pin.length >= PIN_MIN;
  useSoftkeys({ left: S.cancel, center: null, right: ready ? S.ok : null });
  useKeys((e) => {
    if (isDigitKey(e)) {
      if (pin.length < PIN_MAX) setPin(pin + e.key);
    } else if (e.key === 'Backspace') {
      if (pin) setPin(pin.slice(0, -1));
      else finish(undefined);
    } else if (e.key === 'SoftLeft') finish(undefined);
    else if (e.key === 'SoftRight' || e.key === 'Enter') {
      if (ready) finish(pin);
    } else return false;
    return true;
  });
  return (
    <div class="dialog" role="dialog">
      <div class="dialog-title">{props.title}</div>
      <PinDots length={pin.length} />
      <div class="dialog-hint">{props.hint || S.pinHint}</div>
    </div>
  );
}

/** Ask for a 4 to 8 digit PIN; resolves undefined when cancelled. */
export function promptPin(title: string, hint?: string): Promise<string | undefined> {
  return new Promise((resolve) => router.overlay(PinPromptView, { title, hint, resolve }));
}
