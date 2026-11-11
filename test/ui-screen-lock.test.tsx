import './ui-env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'preact-render-to-string';

import { router, RouterView } from '../src/ui/app/router';
import { config } from '../src/ui/data/config';
import * as screenLock from '../src/ui/data/screen-lock';
import { LockGate } from '../src/ui/screens/Lock';
import { PrivacyScreen, ScreenLockScreen } from '../src/ui/screens/Settings';
import { S } from '../src/ui/strings';

const MIN = 60000;

describe('screen lock', () => {
  it('keeps only a salted hash of the PIN and checks it', async () => {
    const a = await screenLock.hashPin('4821');
    const b = await screenLock.hashPin('4821');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash, 'each hash gets its own salt');
    assert.ok(a.iterations >= 100000);
    assert.equal(await screenLock.verifyPin('4821', a), true);
    assert.equal(await screenLock.verifyPin('4822', a), false);
    assert.equal(await screenLock.verifyPin('48210', a), false);

    assert.ok(screenLock.validPin('1234') && screenLock.validPin('12345678'));
    assert.ok(!screenLock.validPin('123') && !screenLock.validPin('123456789') && !screenLock.validPin('12a4'));

    await screenLock.enable('4821', 300);
    const stored = JSON.stringify(config.screenLock());
    assert.ok(!stored.includes('4821'), 'the PIN itself is not stored');
    assert.equal(config.screenLock()!.lockAfter, 300);
    screenLock.disable();
    assert.equal(config.screenLock(), null);
    assert.equal(screenLock.enabled(), false);
  });

  it('locks at launch, and on return once the app was hidden long enough', async () => {
    await screenLock.enable('4821', 300);
    screenLock.install();
    assert.equal(screenLock.isLocked(), true, 'locked at launch');
    screenLock.unlock();

    const t = 1_000_000;
    screenLock.visibilityChanged(true, t);
    assert.equal(screenLock.isLocked(), false);
    screenLock.visibilityChanged(false, t + 5 * MIN - 1);
    assert.equal(screenLock.isLocked(), false, 'back before the wait is up');
    screenLock.visibilityChanged(true, t + 6 * MIN);
    screenLock.visibilityChanged(false, t + 11 * MIN);
    assert.equal(screenLock.isLocked(), true);
    screenLock.unlock();

    screenLock.setLockAfter(0);
    screenLock.visibilityChanged(true, t + 20 * MIN);
    assert.equal(screenLock.isLocked(), true, 'immediately locks as soon as the app is hidden');
    screenLock.visibilityChanged(false, t + 20 * MIN);
    screenLock.unlock();

    screenLock.disable();
    screenLock.visibilityChanged(true, t);
    screenLock.visibilityChanged(false, t + 60 * MIN);
    assert.equal(screenLock.isLocked(), false, 'no lock without a PIN');
    assert.equal(screenLock.lockDue(60, null, t), false);
  });

  it('makes repeated wrong PINs wait, remembers it, and clears it on the right PIN', async () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(screenLock.retryDelayMs), [0, 0, 30000, 60000, 120000]);
    assert.equal(screenLock.retryDelayMs(30), 15 * MIN);
    assert.equal(screenLock.waitLabel(30000), '0:30');
    assert.equal(screenLock.waitLabel(89001), '1:30');

    await screenLock.enable('4821');
    const t = 5_000_000;
    assert.deepEqual(await screenLock.check('0000', t), { ok: false, retryAt: 0 });
    assert.deepEqual(await screenLock.check('1111', t), { ok: false, retryAt: 0 });
    assert.deepEqual(await screenLock.check('2222', t), { ok: false, retryAt: t + 30000 });
    assert.equal(screenLock.retryAt(t + 1000), t + 30000);
    assert.equal(config.screenLock()!.failures, 3, 'kept in settings across restarts');
    assert.deepEqual(await screenLock.check('4821', t + 1000), { ok: false, retryAt: t + 30000 }, 'even the right PIN waits');
    assert.deepEqual(await screenLock.check('3333', t + 30000), { ok: false, retryAt: t + 30000 + 60000 });
    assert.deepEqual(await screenLock.check('4821', t + 90000), { ok: true, retryAt: 0 });
    assert.equal(config.screenLock()!.failures, 0);
    assert.equal(screenLock.retryAt(t + 90000), 0);
    screenLock.disable();
  });

  it('covers the app with the PIN screen while locked', async () => {
    await screenLock.enable('4821');
    screenLock.lockNow();
    let out = renderToString(<LockGate />);
    assert.match(out, /class="lock"/);
    assert.ok(out.includes(S.enterPin) && out.includes(S.forgotPin));
    screenLock.unlock();
    out = renderToString(<LockGate />);
    assert.equal(out, '');

    router.reset(ScreenLockScreen, {});
    out = renderToString(<RouterView />);
    assert.ok(out.includes(S.lockAfter) && out.includes(S.oneMinute));
    router.reset(PrivacyScreen, {});
    assert.ok(renderToString(<RouterView />).includes(S.screenLock));
    screenLock.disable();
    router.reset(ScreenLockScreen, {});
    assert.ok(!renderToString(<RouterView />).includes(S.lockAfter), 'no wait to choose without a PIN');
  });
});
