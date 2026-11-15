import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../brain.mjs';

function setup(t) {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const spoken = [], starts = [], fillers = [];
  const game = {
    state: async () => ({ players: [{ player: 0, room: 'Foyer', floor: 'ground', alive: true, hasKey: false, hint: { text: 'key left' }, stoneHint: { text: 'stone upstairs' }, options: [] }] }),
    secrets: async () => null,
    say: async (_who, text) => { spoken.push(text); },
    choose: async () => 'picked', signal: async () => 'passed',
  };
  let phase = 'lobby';
  const brain = new Brain({ game, phase: () => phase, playersNow: () => 1, startGame: (n, text) => { starts.push({ n, text }); phase = 'playing'; return true; }, filler: () => fillers.push('filler') });
  return { brain, spoken, starts, fillers };
}
const response = message => ({ ok: true, json: async () => ({ choices: [{ message }] }) });

test('brain opens the call and receives live hint data for questions', async t => {
  const { brain, spoken } = setup(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response({ content: requests.length === 1 ? 'Mabel took my stone. Will you help?' : 'The key is to your left.' });
  });
  await brain.situation('call_started');
  await brain.hear(0, 'Where is the key?', 'question');
  assert.deepEqual(spoken, ['Mabel took my stone. Will you help?', 'The key is to your left.']);
  assert.match(requests[0].messages.at(-1).content, /call_started/);
  assert.match(requests[1].messages[1].content, /key left/);
  assert.match(requests[1].messages[1].content, /stone upstairs/);
});

test('brain starts on its tool call and explains controls once afterward', async t => {
  const { brain, spoken, starts } = setup(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response(requests.length === 1
      ? { content: null, tool_calls: [{ function: { name: 'start_game', arguments: '{"players":1}' } }] }
      : { content: 'Point to walk, fist to search, and hold a palm up to stop Mabel.' });
  });
  await brain.hear(0, 'Yes, I will help.', 'lobby');
  await brain.queue;
  assert.deepEqual(starts, [{ n: 1, text: 'Yes, I will help.' }]);
  assert.deepEqual(spoken, ['Point to walk, fist to search, and hold a palm up to stop Mabel.']);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /game_started/);
});

test('brain failure invokes the filler once', async t => {
  const { brain, fillers } = setup(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network failed'); });
  await brain.hear(0, 'How are you?', 'lobby');
  assert.deepEqual(fillers, ['filler']);
});

test('a slow brain invokes the filler and cannot act after timing out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { brain, spoken, starts, fillers } = setup(t);
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  const pending = brain.hear(0, 'Yes.', 'lobby');
  while (!finish) await Promise.resolve();
  t.mock.timers.tick(4000);
  await pending;
  assert.deepEqual(fillers, ['filler']);
  finish(response({ content: 'Late reply', tool_calls: [{ function: { name: 'start_game', arguments: '{"players":1}' } }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(spoken, []);
  assert.deepEqual(starts, []);
  assert.deepEqual(fillers, ['filler']);
});
