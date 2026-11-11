import { useRefresh } from '../../app/hooks';
import { pick } from '../../components/Overlays';
import { promptPin } from '../../components/PinEntry';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import * as screenLock from '../../data/screen-lock';
import { fmt, S } from '../../strings';

export function lockAfterLabel(secs: number): string {
  if (secs === 0) return S.lockImmediately;
  if (secs === 60) return S.oneMinute;
  if (secs === 3600) return S.oneHour;
  return fmt(S.nMinutes, { n: Math.round(secs / 60) });
}

export function pinWaitMessage(retryAt: number): string {
  return fmt(S.pinWait, { time: screenLock.waitLabel(retryAt - Date.now()) });
}

/** A PIN to open the app, and how long it may sit in the background first. Turning it off needs the PIN. */
export function ScreenLockScreen() {
  const refresh = useRefresh();
  const on = screenLock.enabled();

  async function turnOn(): Promise<void> {
    const pin = await promptPin(S.choosePin);
    if (!pin) return;
    const again = await promptPin(S.confirmPin);
    if (again === undefined) return;
    if (again !== pin) {
      toast(S.pinMismatch);
      return;
    }
    await screenLock.enable(pin);
    toast(S.screenLockOn);
    refresh();
  }

  async function turnOff(): Promise<void> {
    const waiting = screenLock.retryAt();
    if (waiting) {
      toast(pinWaitMessage(waiting));
      return;
    }
    const pin = await promptPin(S.enterPin);
    if (!pin) return;
    const res = await screenLock.check(pin);
    if (!res.ok) {
      toast(res.retryAt ? pinWaitMessage(res.retryAt) : S.wrongPin);
      return;
    }
    screenLock.disable();
    toast(S.screenLockOff);
    refresh();
  }

  async function chooseLockAfter(): Promise<void> {
    const current = screenLock.lockAfter();
    const secs = await pick(S.lockAfter, screenLock.LOCK_AFTER_OPTIONS.map((s) => ({ value: s, label: lockAfterLabel(s) })), current);
    if (secs === undefined || secs === current) return;
    screenLock.setLockAfter(secs);
    refresh();
  }

  const rows: Row[] = [
    toggleRow('lock', S.screenLock, on, (v) => void (v ? turnOn() : turnOff()), S.screenLockHint),
    on && { key: 'after', label: S.lockAfter, sub: lockAfterLabel(screenLock.lockAfter()), onSelect: chooseLockAfter },
  ];
  return (
    <Screen title={S.screenLock}>
      <RowList rows={rows} />
    </Screen>
  );
}
