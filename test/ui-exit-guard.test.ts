import './ui-env';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _resetExitGuardForTest, EXIT_CONFIRM_MS, exitConfirmed, installExitGuard } from '../src/ui/app/exit-guard';
import { _keyDownForTest, _stackForTest, router } from '../src/ui/app/router';

const doc = (globalThis as any).document;
let keyup: ((e: any) => void) | null = null;
let now = 0;
let warned = 0;
let armed = 0;

function key(k: string, opts: { repeat?: boolean } = {}) {
  return { key: k, repeat: !!opts.repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} } as any;
}

/** A key press through the router: whether the system would still see it. */
function press(k: string): boolean {
  const down = key(k);
  _keyDownForTest(down);
  const up = key(k);
  if (keyup) keyup(up);
  return !down.defaultPrevented && !up.defaultPrevented;
}

function Plain() {
  return null;
}

beforeEach(() => {
  doc.addEventListener = (type: string, fn: (e: any) => void) => {
    if (type === 'keyup') keyup = fn;
  };
  doc.removeEventListener = () => {
    keyup = null;
  };
  doc.activeElement = null;
  now = 1000000;
  warned = 0;
  armed = 0;
  _resetExitGuardForTest(() => now);
  installExitGuard({ warn: () => warned++, arm: () => armed++ });
  router.reset(Plain, {});
});

afterEach(() => {
  _resetExitGuardForTest();
  doc.addEventListener = () => {};
});

describe('closing Beacon with End', () => {
  it('confirms only a second press within the window', () => {
    assert.equal(exitConfirmed(EXIT_CONFIRM_MS, 0), true);
    assert.equal(exitConfirmed(EXIT_CONFIRM_MS + 1, 0), false);
    assert.equal(exitConfirmed(100, null), false);
    assert.equal(exitConfirmed(-1, 0), false, 'a clock that went back starts over');
  });

  it('holds back the first End, keydown and keyup, warns, and brings the wake alarm forward', () => {
    assert.equal(press('EndCall'), false);
    assert.equal(warned, 1);
    assert.equal(armed, 1);
    now += EXIT_CONFIRM_MS - 1;
    assert.equal(press('EndCall'), true, 'the second press closes Beacon');
    assert.equal(warned, 1);
  });

  it('warns again when the second press comes too late', () => {
    press('EndCall');
    now += EXIT_CONFIRM_MS + 1;
    assert.equal(press('EndCall'), false);
    assert.equal(warned, 2);
    now += 500;
    assert.equal(press('EndCall'), true);
  });

  it('guards End on every screen, unless the screen uses End itself, as the call screen does', () => {
    router.push(Plain, {});
    assert.equal(press('EndCall'), false);
    assert.equal(warned, 1);
    router.overlay(Plain, {});
    const top = _stackForTest().slice(-1)[0] as any;
    top.handlers.push({ current: (e: KeyboardEvent) => e.key === 'EndCall' });
    now += 5000;
    const down = key('EndCall');
    _keyDownForTest(down);
    assert.equal(down.defaultPrevented, true, 'the screen handled it');
    assert.equal(warned, 1, 'without a warning');
  });

  it('lets a held End repeat through', () => {
    const down = key('EndCall', { repeat: true });
    _keyDownForTest(down);
    assert.equal(down.defaultPrevented, false);
    assert.equal(warned, 0);
  });

  it('leaves Back on the first screen to the system, which goes home without closing Beacon', () => {
    assert.equal(press('Backspace'), true);
    assert.equal(warned, 0);
    assert.equal(armed, 0);
  });

  it('does nothing until the app installs it, as before linking', () => {
    _resetExitGuardForTest(() => now);
    assert.equal(press('EndCall'), true);
  });

  // Runs last: going back starts the router's short real-time cooldown for Back on the first screen.
  it('takes Back on a pushed screen to go back, without a warning', () => {
    router.push(Plain, {});
    assert.equal(press('Backspace'), false);
    assert.equal(_stackForTest().length, 1, 'it went back a screen');
    assert.equal(warned, 0);
  });
});
