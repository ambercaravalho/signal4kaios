/* The screen lock cover. It sits outside the router, above every screen and overlay except a call's screen, so nothing opened underneath (a tapped notification, say) shows through, and it takes every key before the router sees it. A call can be answered while locked; the cover comes back when its screen closes. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { isDigitKey, PinDots } from '../components/PinEntry';
import { callView, onCallView } from '../data/calls';
import * as screenLock from '../data/screen-lock';
import { APP_NAME, S } from '../strings';
import { deleteAllData, pinWaitMessage } from './Settings';

export function LockGate() {
  const [locked, setLocked] = useState(screenLock.isLocked());
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [inCall, setInCall] = useState(!!callView());
  const covering = locked && !inCall;

  useEffect(() => onCallView(() => setInCall(!!callView())), []);

  useEffect(
    () =>
      screenLock.onLockChange(() => {
        setLocked(screenLock.isLocked());
        setPin('');
        setWrong(false);
        setForgot(false);
        setNow(Date.now());
      }),
    []
  );

  const waitUntil = locked ? screenLock.retryAt(now) : 0;
  useEffect(() => {
    if (!waitUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waitUntil]);

  useEffect(() => {
    if (!covering) return;
    const prev = document.activeElement as HTMLElement | null;
    if (prev && prev !== document.body && prev.blur) prev.blur();
    return () => {
      if (prev && prev !== document.body && prev.focus && document.contains(prev)) prev.focus();
    };
  }, [covering]);

  async function submit(entered: string): Promise<void> {
    setBusy(true);
    const res = await screenLock.check(entered);
    setBusy(false);
    setPin('');
    setNow(Date.now());
    if (res.ok) screenLock.unlock();
    else setWrong(true);
  }

  const handler = useRef<(e: KeyboardEvent) => void>(() => {});
  handler.current = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (forgot) {
      if (e.key === 'SoftRight') deleteAllData();
      else if (e.key === 'SoftLeft' || e.key === 'Backspace') setForgot(false);
      e.preventDefault();
      return;
    }
    if (isDigitKey(e)) {
      if (!busy && !waitUntil && pin.length < screenLock.PIN_MAX) {
        setPin(pin + e.key);
        setWrong(false);
      }
    } else if (e.key === 'Backspace') {
      // With nothing typed, Back leaves the app as usual.
      if (!pin) return;
      setPin(pin.slice(0, -1));
    } else if (e.key === 'SoftLeft') setForgot(true);
    else if (e.key === 'SoftRight' || e.key === 'Enter') {
      if (!busy && !waitUntil && pin.length >= screenLock.PIN_MIN) submit(pin);
    }
    e.preventDefault();
  };

  useEffect(() => {
    if (!covering) return;
    const fn = (e: KeyboardEvent) => handler.current(e);
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, [covering]);

  if (!covering) return null;
  const hint = waitUntil ? pinWaitMessage(waitUntil) : wrong ? S.wrongPin : S.enterPin;
  return (
    <div class="lock" role="dialog">
      <div class="hdr">{APP_NAME}</div>
      <div class="lock-body">
        {forgot ? (
          <div class="lock-forgot">
            <div class="lock-title">{S.forgotPin}</div>
            <div class="lock-hint">{S.forgotPinBody}</div>
          </div>
        ) : (
          <>
            <div class={'lock-hint' + (wrong || waitUntil ? ' lock-error' : '')}>{hint}</div>
            <PinDots length={pin.length} />
          </>
        )}
      </div>
      <div class="softkeys">
        <span class="sk sk-left">{forgot ? S.cancel : S.forgotPin}</span>
        <span class="sk sk-center" />
        <span class="sk sk-right">{forgot ? S.deleteAllData : busy || waitUntil || pin.length < screenLock.PIN_MIN ? '' : S.unlock}</span>
      </div>
    </div>
  );
}
