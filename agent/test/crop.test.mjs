import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { tileJpeg } from '../listen.mjs';

test('crops a tile and upscales it to the 400 px box', async () => {
  const w = 100, h = 100;
  const pixels = Buffer.alloc(w * h * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 220; pixels[i + 1] = 40; pixels[i + 2] = 20; pixels[i + 3] = 255; }
  const jpg = await tileJpeg(pixels, w, h, { x: 10, y: 20, w: 40, h: 50 }, 0);
  const meta = await sharp(jpg).metadata();
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 400);
});

test('a rotated frame is not cropped with the unrotated box', async () => {
  const w = 120, h = 80;
  const pixels = Buffer.alloc(w * h * 4, 180);
  const jpg = await tileJpeg(pixels, w, h, { x: 0, y: 0, w: 20, h: 20 }, 90);
  const meta = await sharp(jpg).metadata();
  assert.equal(meta.height, 400);
  assert.ok(meta.width > 200 && meta.width < 400, `expected a portrait frame, got ${meta.width}x${meta.height}`);
});
