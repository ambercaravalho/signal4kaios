import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fitGeometry, squareGeometry } from '../src/ui/data/image-scale';

describe('image scaling', () => {
  it('crops the centered square for a profile photo', () => {
    assert.deepEqual(squareGeometry(1600, 1200, 512), { sx: 200, sy: 0, sw: 1200, sh: 1200, width: 512, height: 512 });
    assert.deepEqual(squareGeometry(600, 900, 512), { sx: 0, sy: 150, sw: 600, sh: 600, width: 512, height: 512 });
    assert.deepEqual(squareGeometry(300, 400, 512), { sx: 0, sy: 50, sw: 300, sh: 300, width: 300, height: 300 }, 'small photos are not enlarged');
  });

  it('fits the whole image inside the longest edge', () => {
    assert.deepEqual(fitGeometry(1600, 1200, 800), { sx: 0, sy: 0, sw: 1600, sh: 1200, width: 800, height: 600 });
    assert.deepEqual(fitGeometry(400, 300, 800), { sx: 0, sy: 0, sw: 400, sh: 300, width: 400, height: 300 });
    assert.deepEqual(fitGeometry(0, 0, 800), { sx: 0, sy: 0, sw: 1, sh: 1, width: 1, height: 1 });
  });
});
