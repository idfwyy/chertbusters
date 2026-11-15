import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTiles, parseRects, stabilizeTiles } from '../tiles.mjs';

const W = 640, H = 360;

function frame(rects) {
  const y = new Uint8Array(W * H);
  for (const r of rects) {
    for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) y[yy * W + xx] = 210;
  }
  return y;
}

test('finds two caller tiles and ignores the self-view corner', () => {
  const y = frame([
    { x: 70, y: 45, w: 200, h: 240 },
    { x: 370, y: 45, w: 200, h: 240 },
    { x: 8, y: 285, w: 100, h: 60 },   // self-view thumbnail, lower left
    { x: 560, y: 320, w: 70, h: 30 },  // call buttons, lower right
  ]);
  const boxes = detectTiles(y, W, H);
  assert.equal(boxes.length, 2);
  assert.ok(boxes[0].x < boxes[1].x);
  assert.ok(Math.abs(boxes[0].w - 200) <= 20);
  assert.ok(Math.abs(boxes[1].h - 240) <= 20);
});

test('falls back to the whole frame when nothing is detected', () => {
  const boxes = detectTiles(new Uint8Array(W * H), W, H);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].fallback, true);
  assert.equal(boxes[0].w, W);
  assert.equal(boxes[0].h, H);
});

test('honours normalized TILE_RECTS overrides', () => {
  const rects = parseRects('0.25,0.2,0.5,0.5');
  assert.equal(rects.length, 1);
  const boxes = detectTiles(new Uint8Array(W * H), W, H, { rects });
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].x, 160);
  assert.equal(boxes[0].y, 72);
  assert.equal(boxes[0].w, 320);
  assert.equal(boxes[0].h, 180);
});

test('rejects a bad TILE_RECTS string instead of guessing', () => {
  assert.deepEqual(parseRects('nope'), []);
  assert.deepEqual(parseRects('0.9,0.1,0.4,0.2'), []);
});

test('keeps the old layout until a new one is seen twice', () => {
  const y = frame([{ x: 70, y: 45, w: 200, h: 240 }, { x: 370, y: 45, w: 200, h: 240 }]);
  const first = detectTiles(y, W, H);
  const state = { stable: [], pending: [], pendingCount: 0, nextId: 1 };
  const stable = stabilizeTiles(state, first, W, H);
  assert.equal(stable.length, 2);
  const shifted = first.map(b => ({ ...b, x: b.x + 60 }));
  const once = stabilizeTiles(state, shifted, W, H);
  assert.equal(once[0].x, stable[0].x, 'one odd frame must not move the crop');
  const twice = stabilizeTiles(state, shifted, W, H);
  assert.equal(twice[0].x, stable[0].x + 60, 'two matching frames commit the layout');
});

test('TILE_COUNT=2 splits the frame when only one blob is visible', () => {
  const y = frame([{ x: 200, y: 45, w: 240, h: 240 }]);
  const boxes = detectTiles(y, W, H, { count: 2 });
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].fallback, true);
  assert.equal(boxes[1].fallback, true);
});
