/**
 * The `wasi_snapshot_preview1` imports of the libsignal wasm module, which links wasi-libc for BoringSSL (contact discovery attestation). esbuild aliases the bare module name here (scripts/build.mjs and the test scripts). Nothing in the module opens files, so only the clock and randomness are real; writes (a failed C assertion's message) are dropped.
 */

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const MAX_RANDOM_CHUNK = 65536;

let memory: WebAssembly.Memory | null = null;

/** Called with the instance's exported memory as soon as the module is instantiated, before any export runs. */
export function setWasiMemory(m: WebAssembly.Memory): void {
  memory = m;
}

function mem(): ArrayBuffer {
  if (!memory) throw new Error('wasi: memory not set');
  return memory.buffer;
}

export function clock_time_get(_id: number, _precision: bigint, out: number): number {
  new DataView(mem()).setBigUint64(out, BigInt(Date.now()) * BigInt(1_000_000), true);
  return ERRNO_SUCCESS;
}

export function random_get(buf: number, len: number): number {
  for (let off = 0; off < len; off += MAX_RANDOM_CHUNK) {
    crypto.getRandomValues(new Uint8Array(mem(), buf + off, Math.min(MAX_RANDOM_CHUNK, len - off)));
  }
  return ERRNO_SUCCESS;
}

export function fd_write(_fd: number, iovs: number, iovsLen: number, written: number): number {
  const view = new DataView(mem());
  let total = 0;
  for (let i = 0; i < iovsLen; i++) total += view.getUint32(iovs + i * 8 + 4, true);
  view.setUint32(written, total, true);
  return ERRNO_SUCCESS;
}

export function fd_seek(): number {
  return ERRNO_BADF;
}

export function fd_close(): number {
  return ERRNO_BADF;
}

export function fd_prestat_get(): number {
  return ERRNO_BADF;
}

export function fd_prestat_dir_name(): number {
  return ERRNO_BADF;
}

export function proc_exit(code: number): never {
  throw new Error(`libsignal wasm exited (${code})`);
}
