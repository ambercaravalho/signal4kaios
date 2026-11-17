import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from '../src/engine/bytes';
import { attachmentCiphertextLength, attachmentPaddedSize, decryptAttachment, encryptAttachment } from '../src/engine/crypto/attachment';
import { SignalClient } from '../src/engine/net/client';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

describe('Attachments (Signal-Desktop AttachmentCrypto)', () => {
  it('pads to Signal-Desktop logPadSize buckets', () => {
    assert.equal(attachmentPaddedSize(0), 541);
    assert.equal(attachmentPaddedSize(1), 541);
    assert.equal(attachmentPaddedSize(541), 541);
    assert.equal(attachmentPaddedSize(542), 568);
    assert.equal(attachmentPaddedSize(1021), 1071);
    assert.equal(attachmentPaddedSize(102224512), 102224512);
  });

  it('round-trips with HMAC and digest checks; the pointer size strips the padding', async () => {
    const original = new TextEncoder().encode('Attachment binary content on KaiOS');
    const enc = await encryptAttachment(original);
    assert.equal(enc.ciphertext.length, 16 + 544 + 32);
    const dec = await decryptAttachment(enc.ciphertext, enc.key, enc.digest);
    assert.equal(dec.length, 541);
    assert.deepEqual(dec.subarray(0, original.length), original);

    const tampered = new Uint8Array(enc.ciphertext);
    tampered[20] ^= 1;
    await assert.rejects(decryptAttachment(tampered, enc.key));
    await assert.rejects(decryptAttachment(enc.ciphertext, enc.key, randomBytes(32)));
  });

  it('knows the exact ciphertext length for a size, and caps a CDN download at it', async () => {
    for (const n of [1, 540, 541, 542, 1000, 4096, 65000]) assert.equal((await encryptAttachment(randomBytes(n))).ciphertext.length, attachmentCiphertextLength(n), String(n));
    const enc = await encryptAttachment(randomBytes(1000));
    const caps: Array<number | undefined> = [];
    const httpBinary = async (_m: string, _u: string, _b?: Uint8Array | null, _h?: Record<string, string>, _t?: number, maxBytes?: number) => {
      caps.push(maxBytes);
      return enc.ciphertext;
    };
    const client = new SignalClient({} as any, (async () => null) as any, httpBinary);
    const pointer = (size: number) => ({ attachmentIdentifier: { case: 'cdnKey', value: 'abc' }, cdnNumber: 0, key: enc.key, digest: enc.digest, contentType: 'image/jpeg', size }) as any;
    const got = await client.downloadAttachment(pointer(1000));
    assert.equal(got.bytes.length, 1000);
    await client.downloadAttachment(pointer(0));
    assert.deepEqual(caps, [attachmentCiphertextLength(1000), undefined]);
  });
});
