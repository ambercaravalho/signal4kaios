import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from '../src/engine/bytes';
import { attachmentPaddedSize, decryptAttachment, encryptAttachment } from '../src/engine/crypto/attachment';
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
});
