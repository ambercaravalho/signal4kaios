/* Fixtures and byte/timing helpers shared by the Node unit tests. Unlike `support.ts`, nothing here loads the wasm build or the engine, so UI tests can import it freely. */

export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const CAROL = '33333333-3333-4333-8333-333333333333';
export const DAVE = '44444444-4444-4444-8444-444444444444';
export const ERIN = '55555555-5555-4555-8555-555555555555';

export function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const text = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s));
export const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
export const u8 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
