import test from 'node:test';
import assert from 'node:assert/strict';
import { openGame } from '../game.mjs';

// Exercise the page's public command API against the real Landing layout.
test('Landing commands target the sealed door without taking the wrong stairs', { timeout: 60000 }, async () => {
  process.env.GAME_SOFTWARE_GL = '1';
  const game = await openGame({ dir: new URL('../../game/', import.meta.url).pathname, query: '&skipintro=1&debug=1&seed=7&speed=8&time=1800' });
  try {
    await game.start(1);
    const result = await game.evaluate(async () => {
      const debug = window.deadLine.debug();
      debug.travelTo(0, 'landing');
      const door = window.deadLine.state().players[0].options.find(o => o.sealed);
      const room = window.deadLine.secrets().stoneRoom;
      const selected = [];
      for (const text of ['go up to the red door', 'sealed door', `go to the ${room}`, 'open the red door']) {
        const outcome = window.deadLine.command(0, text);
        selected.push({ text, outcome, picked: window.deadLine.state().players[0].picked });
        const deadline = performance.now() + 10000;
        while (window.deadLine.state().players[0].picked && performance.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 50));
      }
      const up = window.deadLine.command(0, 'up');
      const upstairs = window.deadLine.command(0, 'upstairs');
      const unrelated = window.deadLine.command(0, 'go up please');
      const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
      hand[0] = { x: 0.5, y: 0.1 };
      hand[2] = { x: 0.4, y: 0.54 }; hand[3] = { x: 0.42, y: 0.52 }; hand[4] = { x: 0.44, y: 0.5 };
      for (const [m, p, tip, x, y] of [[5, 6, 8, 0.42, 0.5], [9, 10, 12, 0.5, 0.5], [13, 14, 16, 0.58, 0.5], [17, 18, 20, 0.66, 0.52]]) {
        hand[m] = { x, y }; hand[p] = { x, y: y - 0.08 }; hand[tip] = { x, y: y - 0.02 };
      }
      hand[6] = { x: 0.42, y: 0.58 };
      hand[8] = { x: 0.53, y: 0.68 };
      debug.debugHand(0, hand);
      await new Promise(resolve => setTimeout(resolve, 850));
      debug.debugHand(0, hand);
      const shallowPick = window.deadLine.state().players[0].picked;
      hand[8] = { x: 0.42, y: 0.68 };
      debug.debugHand(0, hand);
      await new Promise(resolve => setTimeout(resolve, 550));
      debug.debugHand(0, hand);
      const earlyPick = window.deadLine.state().players[0].picked;
      await new Promise(resolve => setTimeout(resolve, 250));
      debug.debugHand(0, hand);
      const heldPick = window.deadLine.state().players[0].picked;
      const deadline = performance.now() + 10000;
      while (window.deadLine.state().players[0].picked && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 50));
      debug.travelTo(0, 'landing');
      const down = window.deadLine.command(0, 'down');
      return { door: door.key, selected, up, upstairs, unrelated, down, downPick: window.deadLine.state().players[0].picked, shallowPick, earlyPick, heldPick };
    });
    for (const choice of result.selected) {
      assert.equal(choice.outcome, 'picked', choice.text);
      assert.equal(choice.picked, result.door, choice.text);
    }
    assert.equal(result.up, 'blocked');
    assert.equal(result.upstairs, 'blocked');
    assert.notEqual(result.unrelated, 'picked');
    assert.equal(result.down, 'picked');
    assert.equal(result.shallowPick, null);
    assert.equal(result.earlyPick, null);
    assert.equal(result.heldPick, 'stairs');
    assert.equal(result.downPick, 'stairs');
  } finally {
    await game.close();
  }
});
