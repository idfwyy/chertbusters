import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHand, handRaised, pointDirection } from '../../game/gestures.js';

function blank() {
  return Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
}

function finger(lm, mcp, pip, tip, x, y, extended, dir = 'up') {
  lm[mcp] = { x, y };
  if (dir === 'right') {
    lm[pip] = { x: x + 0.08, y };
    lm[tip] = extended ? { x: x + 0.18, y } : { x: x + 0.02, y };
  } else {
    lm[pip] = { x, y: y - 0.08 };
    lm[tip] = extended ? { x, y: y - 0.18 } : { x, y: y - 0.02 };
  }
}

function hand({ index = true, middle = true, ring = true, pinky = true, thumb = false, indexDir = 'up', wristY = 0.62 } = {}) {
  const lm = blank();
  lm[0] = { x: 0.5, y: wristY };
  lm[1] = { x: 0.42, y: wristY - 0.04 };
  lm[2] = { x: 0.4, y: wristY - 0.08 };
  lm[3] = thumb ? { x: 0.38, y: wristY - 0.16 } : { x: 0.42, y: wristY - 0.1 };
  lm[4] = thumb ? { x: 0.37, y: wristY - 0.24 } : { x: 0.44, y: wristY - 0.12 };
  finger(lm, 5, 6, 8, 0.42, 0.5, index, indexDir);
  finger(lm, 9, 10, 12, 0.5, 0.5, middle);
  finger(lm, 13, 14, 16, 0.58, 0.5, ring);
  finger(lm, 17, 18, 20, 0.66, 0.52, pinky);
  return lm;
}

test('open palm', () => {
  const r = classifyHand(hand({ thumb: false }));
  assert.equal(r.gesture, 'open_palm');
});

test('fist', () => {
  const r = classifyHand(hand({ index: false, middle: false, ring: false, pinky: false }));
  assert.equal(r.gesture, 'fist');
});

test('thumbs up', () => {
  const r = classifyHand(hand({ index: false, middle: false, ring: false, pinky: false, thumb: true }));
  assert.equal(r.gesture, 'thumbs_up');
});

test('point right is the player left when the feed is not mirrored', () => {
  const lm = hand({ middle: false, ring: false, pinky: false, indexDir: 'right' });
  assert.equal(pointDirection(lm), 'right');
  assert.equal(classifyHand(lm, { mirror: false }).direction, 'left');
  assert.equal(classifyHand(lm, { mirror: true }).direction, 'right');
});

test('point up', () => {
  const r = classifyHand(hand({ middle: false, ring: false, pinky: false }));
  assert.equal(r.gesture, 'point');
  assert.equal(r.imageDirection, 'up');
  assert.equal(r.direction, 'up');
});

test('a raised hand is recognised by the lobby calibration', () => {
  assert.equal(handRaised(hand()), true);
  assert.equal(handRaised(hand({ wristY: 0.9 })), false);
});

test('garbage landmarks do not throw', () => {
  assert.equal(classifyHand([]).gesture, 'none');
  assert.equal(classifyHand(null).gesture, 'none');
});
