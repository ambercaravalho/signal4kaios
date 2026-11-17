/* The screen lock cover. It sits outside the router, above every screen and overlay except a call's screen, so nothing opened underneath (a tapped notification, say) shows through, and it takes every key before the router sees it. A call can be answered while locked; the cover comes back as soon as it ends. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { isDigitKey, PinDots } from '../components/PinEntry';
import { callView, onCallView } from '../data/calls';

function liveCall(): boolean {
  const v = callView();
  return !!v && v.call.phase !== 'ended';
}
import * as screenLock from '../data/screen-lock';
import { APP_NAME, S } from '../strings';
import { deleteAllData, pinWaitMessage } from './Settings';

type ForgotStep = 'pin' | 'forgot' | 'confirm';

/** Forgot PIN explains, then asks once more with Delete on OK, so pressing Right twice can't wipe the phone. */
export function forgotStep(step: ForgotStep, key: string): ForgotStep | 'wipe' {
  if (step === 'pin') return key === 'SoftLeft' ? 'forgot' : 'pin';
  if (key === 'SoftLeft' || key === 'Backspace') return 'pin';
  if (step === 'forgot') return key === 'SoftRight' ? 'confirm' : 'forgot';
  return key === 'Enter' ? 'wipe' : 'confirm';
}

export function LockGate() {
  const [locked, setLocked] = useState(screenLock.isLocked());
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<ForgotStep>('pin');
  const [, setTick] = useState(0);
  const [inCall, setInCall] = useState(liveCall());
  const covering = locked && !inCall;

  useEffect(() => onCallView(() => setInCall(liveCall())), []);

  useEffect(
    () =>
      screenLock.onLockChange(() => {
        setLocked(screenLock.isLocked());
        setPin('');
        setWrong(false);
        setStep('pin');
        setTick((n) => n + 1);
      }),
    []
  );

  const waitMs = locked ? screenLock.waitLeft() : 0;
  const waiting = waitMs > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);

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
    setTick((n) => n + 1);
    if (res.ok) screenLock.unlock();
    else setWrong(true);
  }

  const handler = useRef<(e: KeyboardEvent) => void>(() => {});
  handler.current = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (step !== 'pin') {
      const next = forgotStep(step, e.key);
      if (next === 'wipe') deleteAllData();
      else setStep(next);
      e.preventDefault();
      return;
    }
    if (isDigitKey(e)) {
      if (!busy && !waiting && pin.length < screenLock.PIN_MAX) {
        setPin(pin + e.key);
        setWrong(false);
      }
    } else if (e.key === 'Backspace') {
      // With nothing typed, Back leaves the app as usual.
      if (!pin) return;
      setPin(pin.slice(0, -1));
    } else if (e.key === 'SoftLeft') setStep('forgot');
    else if (e.key === 'SoftRight' || e.key === 'Enter') {
      if (!busy && !waiting && pin.length >= screenLock.PIN_MIN) submit(pin);
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
  const hint = waiting ? pinWaitMessage(waitMs) : wrong ? S.wrongPin : S.enterPin;
  const forgot = step !== 'pin';
  return (
    <div class="lock" role="dialog">
      <div class="hdr">{APP_NAME}</div>
      <div class="lock-body">
        {forgot ? (
          <div class="lock-forgot">
            <div class="lock-title">{step === 'confirm' ? S.deleteAllData + '?' : S.forgotPin}</div>
            <div class={'lock-hint' + (step === 'confirm' ? ' lock-error' : '')}>{step === 'confirm' ? S.forgotPinConfirm : S.forgotPinBody}</div>
          </div>
        ) : (
          <>
            <div class={'lock-hint' + (wrong || waiting ? ' lock-error' : '')}>{hint}</div>
            <PinDots length={pin.length} />
          </>
        )}
      </div>
      <div class="softkeys">
        <span class="sk sk-left">{forgot ? S.cancel : S.forgotPin}</span>
        <span class="sk sk-center">{step === 'confirm' ? S.delete : ''}</span>
        <span class="sk sk-right">{step === 'forgot' ? S.deleteAllData : forgot || busy || waiting || pin.length < screenLock.PIN_MIN ? '' : S.unlock}</span>
      </div>
    </div>
  );
}
