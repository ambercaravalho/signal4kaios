/**
 * Loader for the official libsignal crates compiled to WebAssembly (native/libsignal-wasm). Every Signal Protocol operation in the engine goes through `libsignal`; nothing may call it before `loadLibsignal` resolves.
 */
import init, { initSync, libsignalVersion } from '../../native/libsignal-wasm/pkg/libsignal_wasm.js';

export * as libsignal from '../../native/libsignal-wasm/pkg/libsignal_wasm.js';

/** Path of the wasm binary inside the packaged app, relative to index.html. */
export const LIBSIGNAL_WASM_PATH = 'vendor/libsignal_wasm_bg.wasm';

let loading: Promise<string> | null = null;
let loaded = false;

export class LibsignalUnavailableError extends Error {
  /** `no-webassembly`: the WebAssembly global is missing; `blocked`: compiling was refused (CSP without `'wasm-unsafe-eval'` on KaiOS 4.0); `fetch`: the binary could not be read. */
  readonly reason: 'no-webassembly' | 'blocked' | 'fetch';

  constructor(reason: 'no-webassembly' | 'blocked' | 'fetch', message: string) {
    super(message);
    this.name = 'LibsignalUnavailableError';
    this.reason = reason;
  }
}

async function fetchWasm(path: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (e) {
    throw new LibsignalUnavailableError('fetch', `could not read ${path}: ${(e as Error).message}`);
  }
}

/** Fetches and instantiates the wasm module once; later calls share the same promise. Resolves to the pinned libsignal version. */
export function loadLibsignal(path: string = LIBSIGNAL_WASM_PATH): Promise<string> {
  if (!loading) {
    loading = (async () => {
      if (typeof WebAssembly === 'undefined') {
        throw new LibsignalUnavailableError('no-webassembly', 'WebAssembly is not available in this browser engine');
      }
      const bytes = await fetchWasm(path);
      try {
        await init({ module_or_path: bytes });
      } catch (e) {
        throw new LibsignalUnavailableError('blocked', `WebAssembly compile failed: ${(e as Error).message}`);
      }
      loaded = true;
      return libsignalVersion();
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Synchronous instantiation from bytes already in memory (Node tests). */
export function loadLibsignalSync(bytes: BufferSource): string {
  if (!loaded) {
    initSync({ module: bytes });
    loaded = true;
  }
  return libsignalVersion();
}

export function isLibsignalLoaded(): boolean {
  return loaded;
}
