import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { greetWithFallback } from '../greet.mjs';

class Room extends EventEmitter {
  metadata = '{}';
  ready() { this.metadata = '{"chert_bridge_ready":true}'; this.emit('roomMetadataChanged'); }
}

test('bridge readiness greets once and cancels the caller fallback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new Room();
  let greetings = 0, readyEvents = 0;
  const greeting = greetWithFallback(room, () => greetings++, () => readyEvents++);
  greeting.callerJoined();
  t.mock.timers.tick(1000);
  assert.equal(greetings, 0);
  room.ready();
  t.mock.timers.tick(2000);
  room.ready();
  assert.equal(greetings, 1);
  assert.equal(readyEvents, 1);
  greeting.stop();
});

test('caller fallback greets once and still observes a late bridge', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new Room();
  let greetings = 0, readyEvents = 0;
  const greeting = greetWithFallback(room, () => greetings++, () => readyEvents++);
  greeting.callerJoined();
  greeting.callerJoined();
  t.mock.timers.tick(1999);
  assert.equal(greetings, 0);
  t.mock.timers.tick(1);
  assert.equal(greetings, 1);
  room.ready();
  assert.equal(greetings, 1);
  assert.equal(readyEvents, 1);
  greeting.stop();
});

test('already-ready bridge greets without waiting for a caller', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new Room();
  room.metadata = '{"chert_bridge_ready":true}';
  let greetings = 0;
  const greeting = greetWithFallback(room, () => greetings++);
  greeting.callerJoined();
  t.mock.timers.tick(2000);
  assert.equal(greetings, 1);
  greeting.stop();
});

test('stopping before readiness cancels the fallback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new Room();
  let greetings = 0;
  const greeting = greetWithFallback(room, () => greetings++);
  greeting.callerJoined();
  greeting.stop();
  t.mock.timers.tick(2000);
  room.ready();
  assert.equal(greetings, 0);
});
