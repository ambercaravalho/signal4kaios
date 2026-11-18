import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const STOCK_KAIOS4 = "default-src * data: blob:; script-src blob: 'self' http://127.0.0.1 http://shared.localhost; object-src 'none'; style-src 'self' 'unsafe-inline' http://shared.localhost";
const WITH_WASM = "default-src * data: blob:; script-src blob: 'self' http://127.0.0.1 http://shared.localhost 'wasm-unsafe-eval'; object-src 'none'; style-src 'self' 'unsafe-inline' http://shared.localhost";

function loadWorker(serve: (req: any) => Promise<Response>) {
  const handlers: Record<string, (event: any) => void> = {};
  const ctx: any = {
    Headers,
    Response,
    fetch: serve,
    self: { addEventListener: (type: string, fn: (event: any) => void) => (handlers[type] = fn) },
  };
  runInNewContext(readFileSync(join(process.cwd(), 'src/app/sw.js'), 'utf8'), ctx);
  return { allowWasm: ctx.allowWasm as (header: string) => string | null, handlers };
}

function page(headers: Record<string, string>, status = 200): Response {
  return new Response('<html></html>', { status, headers: { 'Content-Type': 'text/html', ...headers } });
}

async function navigate(response: Response, mode = 'navigate'): Promise<Response | null> {
  const { handlers } = loadWorker(async () => response);
  let answer: Promise<Response> | null = null;
  handlers.fetch({ request: { mode, url: 'http://signal4kaios.localhost/index.html' }, respondWith: (p: Promise<Response>) => (answer = p) });
  return answer;
}

describe('service worker: WebAssembly on KaiOS 4.0', () => {
  const { allowWasm } = loadWorker(async () => page({}));

  it("adds only 'wasm-unsafe-eval' to api-daemon's script-src", () => {
    assert.equal(allowWasm(STOCK_KAIOS4), WITH_WASM);
  });

  it('extends script-src in every policy of a combined header', () => {
    assert.equal(allowWasm("script-src 'self', default-src 'self'; script-src blob:"), "script-src 'self' 'wasm-unsafe-eval', default-src 'self'; script-src blob: 'wasm-unsafe-eval'");
  });

  it('leaves policies that already allow WebAssembly or have no script-src', () => {
    assert.equal(allowWasm(WITH_WASM), null);
    assert.equal(allowWasm("script-src 'self' 'unsafe-eval'"), null);
    assert.equal(allowWasm("default-src 'self'"), null);
    assert.equal(allowWasm("script-src 'self', default-src 'self'"), null);
    assert.equal(allowWasm("script-src-elem 'self'"), null);
  });

  it('re-serves the app page with the extended policy and the same body', async () => {
    const res = await navigate(page({ 'Content-Security-Policy': STOCK_KAIOS4, 'Content-Encoding': 'gzip', 'X-Other': 'kept' }));
    assert.ok(res);
    assert.equal(res.headers.get('Content-Security-Policy'), WITH_WASM);
    assert.equal(res.headers.get('X-Other'), 'kept');
    assert.equal(res.headers.get('Content-Encoding'), null);
    assert.equal(res.headers.get('Content-Type'), 'text/html');
    assert.equal(await res.text(), '<html></html>');
  });

  it('passes other pages through unchanged', async () => {
    const failed = page({ 'Content-Security-Policy': STOCK_KAIOS4 }, 404);
    assert.equal(await navigate(failed), failed);
    const noPolicy = page({});
    assert.equal(await navigate(noPolicy), noPolicy);
    const allowed = page({ 'Content-Security-Policy': WITH_WASM });
    assert.equal(await navigate(allowed), allowed);
  });

  it('leaves requests other than page loads alone', async () => {
    assert.equal(await navigate(page({ 'Content-Security-Policy': STOCK_KAIOS4 }), 'no-cors'), null);
  });
});

const NOTICE = { title: 'Beacon was closed', body: 'Select to open Beacon.' };

/** Objects made inside the worker's context, as plain data. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

/** The worker with fake clients, notifications, and alarms. `open` stands in for `clients.openWindow`. */
function supervisor(opts: { clients?: any[]; open?: (url: string, o: any) => Promise<any> } = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const log = { posted: [] as any[], opened: [] as Array<{ url: string; o: any }>, shown: [] as any[], alarms: [] as any[], focused: 0 };
  const clients = opts.clients || [];
  const open: Array<{ tag: string }> = [];
  const ctx: any = {
    Headers,
    Response,
    setTimeout,
    fetch: async () => page({}),
    self: {
      addEventListener: (type: string, fn: (event: any) => void) => (handlers[type] = fn),
      clients: {
        matchAll: async () => clients,
        openWindow: (url: string, o: any) => {
          log.opened.push({ url, o });
          return opts.open ? opts.open(url, o) : Promise.reject(new TypeError("'background' is not a valid value for enumeration ClientDisposition."));
        },
      },
      registration: {
        getNotifications: async (f: { tag: string }) => open.filter((n) => n.tag === f.tag),
        showNotification: async (title: string, o: any) => {
          log.shown.push({ title, ...o });
          open.push({ tag: o.tag });
        },
      },
      navigator: { b2g: { alarmManager: { add: async (a: any) => log.alarms.push(a) } } },
    },
  };
  runInNewContext(readFileSync(join(process.cwd(), 'src/app/sw.js'), 'utf8'), ctx);
  async function alarm(data: unknown) {
    let work: Promise<unknown> | null = null;
    handlers.systemmessage({ name: 'alarm', data: { json: () => ({ id: 1, date: '', data }) }, waitUntil: (p: Promise<unknown>) => (work = p) });
    if (work) await work;
    return !!work;
  }
  return { handlers, log, alarm };
}

function windowClient(log?: { posted: any[]; focused: number }) {
  return {
    url: 'http://signal4kaios.localhost/index.html',
    postMessage: (m: any) => log && log.posted.push(m),
    focus: async () => {
      if (log) log.focused++;
    },
  };
}

describe('service worker: keeping Beacon running', () => {
  it('relays the wake alarm to an open window, which reconnects and schedules the next one', async () => {
    const seen = { posted: [] as any[], focused: 0 };
    const { log, alarm } = supervisor({ clients: [windowClient(seen)] });
    await alarm({ type: 's4k-wake', notice: NOTICE });
    assert.deepEqual(plain(seen.posted), [{ type: 's4k-wake' }]);
    assert.deepEqual(log.opened, []);
    assert.deepEqual(log.shown, []);
    assert.deepEqual(log.alarms, []);
  });

  it('with Beacon closed, tries a hidden relaunch, then shows one notice in the app’s words and stops the chain', async () => {
    const { log, alarm } = supervisor();
    await alarm({ type: 's4k-wake', notice: NOTICE });
    assert.deepEqual(plain(log.opened), [{ url: '/index.html#bg', o: { disposition: 'background' } }]);
    assert.equal(log.shown.length, 1);
    assert.equal(log.shown[0].title, NOTICE.title);
    assert.equal(log.shown[0].body, NOTICE.body);
    assert.equal(log.shown[0].tag, 's4k-stopped');
    assert.deepEqual(log.alarms, [], 'nothing to supervise until Beacon opens again');
    await alarm({ type: 's4k-wake', notice: NOTICE });
    assert.equal(log.shown.length, 1, 'the open notice is not shown again');
  });

  it('when a hidden relaunch works, keeps the chain going with the same notice', async () => {
    const { log, alarm } = supervisor({ open: async () => windowClient() });
    const before = Date.now();
    await alarm({ type: 's4k-wake', notice: NOTICE });
    assert.deepEqual(log.shown, []);
    assert.equal(log.alarms.length, 1);
    assert.equal(log.alarms[0].data.type, 's4k-wake');
    assert.deepEqual(plain(log.alarms[0].data.notice), NOTICE);
    const due = log.alarms[0].date.getTime() - before;
    assert.ok(due >= 300000 && due < 301000, 'five minutes on');
  });

  it('shows no notice when a relaunch returns no window and the alarm carried no wording', async () => {
    const { log, alarm } = supervisor({ open: async () => null });
    await alarm({ type: 's4k-wake' });
    assert.deepEqual(log.shown, []);
  });

  it('brings an open window forward for an incoming call, and does nothing when Beacon is closed', async () => {
    const seen = { posted: [] as any[], focused: 0 };
    await supervisor({ clients: [windowClient(seen)] }).alarm({ type: 's4k-focus' });
    assert.equal(seen.focused, 1);
    const closed = supervisor();
    await closed.alarm({ type: 's4k-focus' });
    assert.deepEqual(closed.log.opened, [], 'a closed Beacon is not opened for it');
  });

  it('ignores other system messages and alarms it didn’t set', async () => {
    const { handlers, log, alarm } = supervisor();
    assert.equal(await alarm({ type: 'someone-else' }), false);
    assert.equal(await alarm(null), false);
    let work = null;
    handlers.systemmessage({ name: 'sms-received', data: { json: () => ({}) }, waitUntil: (p: any) => (work = p) });
    assert.equal(work, null);
    assert.deepEqual(log.opened, []);
  });

  it('answers a tick request when it’s due, echoing its id, with the wait kept between 1 and 60 seconds', async () => {
    const { handlers } = supervisor();
    const got: any[] = [];
    let work: Promise<unknown> | null = null;
    const started = Date.now();
    handlers.message({ data: { type: 's4k-tick', ms: 5, id: 7 }, source: { postMessage: (m: any) => got.push(m) }, waitUntil: (p: Promise<unknown>) => (work = p) });
    assert.ok(work, 'the wait keeps the worker alive');
    await work;
    assert.ok(Date.now() - started >= 990, 'at least a second');
    assert.deepEqual(plain(got), [{ type: 's4k-tick', id: 7 }]);
    let other = null;
    handlers.message({ data: { type: 's4k-other' }, waitUntil: (p: any) => (other = p) });
    assert.equal(other, null);
  });

  it('opens Beacon when the notice is selected', async () => {
    const { handlers, log } = supervisor({ open: async () => windowClient() });
    let work: Promise<unknown> | null = null;
    let closed = false;
    handlers.notificationclick({ notification: { data: { reopen: true }, close: () => (closed = true) }, waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
    assert.ok(closed);
    assert.deepEqual(log.opened.map((o) => o.url), ['/index.html']);
  });
});
