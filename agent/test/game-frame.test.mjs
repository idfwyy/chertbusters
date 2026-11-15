import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { openGame, WIDTH, HEIGHT } from '../game.mjs';

// Check the captured pixels, not just the advertised track dimensions: a square
// track containing a stretched or center-cropped game still loses the intended UI.
test('outgoing video preserves both landscape edges inside an opaque square', { timeout: 60000 }, async () => {
  const game = await openGame({ dir: new URL('../../game/', import.meta.url).pathname });
  try {
    const viewport = await game.evaluate(() => {
      const marker = document.createElement('div');
      marker.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0000ff;pointer-events:none';
      for (const [side, color] of [['left', '#ff0000'], ['right', '#00ff00']]) {
        const edge = document.createElement('div');
        edge.style.cssText = `position:absolute;top:0;bottom:0;${side}:0;width:80px;background:${color}`;
        marker.append(edge);
      }
      document.body.append(marker);
      return [innerWidth, innerHeight];
    });
    assert.deepEqual(viewport, [1280, 720]);
    assert.equal(WIDTH, HEIGHT);
    const pixel = (frame, x, y) => [...frame.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4)];
    const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) <= 8);
    const top = (HEIGHT - viewport[1]) / 2;
    let frame;
    const deadline = Date.now() + 15000;
    do {
      frame = game.latestFrame();
      if (near(pixel(frame, WIDTH / 2, HEIGHT / 2), [0, 0, 255, 255])) break;
      await sleep(50);
    } while (Date.now() < deadline);
    assert.equal(frame.length, WIDTH * HEIGHT * 4);
    for (const y of [0, top - 1, top + viewport[1], HEIGHT - 1])
      assert.deepEqual(pixel(frame, WIDTH / 2, y), [0, 0, 0, 255], `opaque padding at y=${y}`);
    for (const y of [top + 10, HEIGHT / 2, top + viewport[1] - 10]) {
      assert.ok(near(pixel(frame, 10, y), [255, 0, 0, 255]), `left edge at y=${y}`);
      assert.ok(near(pixel(frame, WIDTH - 11, y), [0, 255, 0, 255]), `right edge at y=${y}`);
      assert.ok(near(pixel(frame, WIDTH / 2, y), [0, 0, 255, 255]), `uncropped content at y=${y}`);
    }
  } finally {
    await game.close();
  }
});
