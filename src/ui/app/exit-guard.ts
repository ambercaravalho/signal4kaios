/* End closes a KaiOS app outright, and a closed Beacon gets no messages or calls. The first press only warns; a second press soon after closes Beacon. */

export const EXIT_CONFIRM_MS = 3000;

export interface ExitHooks {
  /** Tell the user how to close Beacon, or keep it running. */
  warn(): void;
  /** Beacon may be about to close. */
  arm(): void;
}

let hooks: ExitHooks | null = null;
let armedAt: number | null = null;
let swallowKeyup = false;
let clock: () => number = () => Date.now();

/** Whether a press at `now` confirms closing, after the first press at `prev`. */
export function exitConfirmed(now: number, prev: number | null): boolean {
  return prev !== null && now - prev >= 0 && now - prev <= EXIT_CONFIRM_MS;
}

/** For an End press nothing else handled: true when the press was held back and the caller must `preventDefault()` it. Does nothing until `installExitGuard`. */
export function guardExit(evt: KeyboardEvent): boolean {
  if (!hooks || evt.key !== 'EndCall' || evt.repeat) return false;
  const now = clock();
  if (exitConfirmed(now, armedAt)) {
    armedAt = null;
    return false;
  }
  armedAt = now;
  swallowKeyup = true;
  hooks.arm();
  hooks.warn();
  return true;
}

/** The system acts on the key's release too, so a held-back press has its keyup cancelled as well. */
function onKeyUp(evt: KeyboardEvent): void {
  if (!swallowKeyup || evt.key !== 'EndCall') return;
  swallowKeyup = false;
  evt.preventDefault();
}

export function installExitGuard(h: ExitHooks): void {
  if (!hooks) document.addEventListener('keyup', onKeyUp);
  hooks = h;
}

export function _resetExitGuardForTest(now?: () => number): void {
  if (hooks) document.removeEventListener('keyup', onKeyUp);
  hooks = null;
  armedAt = null;
  swallowKeyup = false;
  clock = now || (() => Date.now());
}
