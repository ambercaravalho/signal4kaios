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
