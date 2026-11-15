// Try the whole call on your Mac without Chert and without using FaceTime minutes.
// A window shows exactly what the callers would see. You type what the players would say.
// Plain commands run at once; anything else goes to Chert's brain, the same as on a real call.
// With keys in .env.local, Chert's voice plays through your Mac speakers.
//
//   npm run preview
//   then type:  1 hey chert what do we do?      (lobby chat; the brain starts the game when you say ready)
//               1 left                          Batman says "left"
//               2 go check that cabinet thing   (the brain works out what Spider-Man meant)
//               1 !motion                       pretend Batman moved on camera (also !light, !smile)
//               quit
import { createInterface } from 'node:readline';
import { writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openGame } from './game.mjs';
import { synth } from './voice.mjs';
import { Brain } from './brain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const game = await openGame({ dir: process.env.GAME_DIR || join(HERE, '..', 'game'), show: true, query: '&voicesync=1&localcam=1' });
let phase = 'lobby', players = 2;

const lines = [];
let playing = false;
async function speakLoop() {
  if (playing) return; playing = true;
  while (lines.length) {
    const { who, text, id } = lines.shift();
    const est = Math.max(1500, text.length * 64);
    try {
      if (process.platform !== 'darwin' || !(process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY)) throw new Error('no voice here');
      const { res, ext } = await synth(who, text, true);
      const file = join(tmpdir(), `deadline-${Date.now()}.${ext}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      if (id) await game.voiceStart(id, est);
      await new Promise(done => spawn('afplay', [file]).on('exit', done));
      await unlink(file).catch(() => {});
    } catch (error) {
      if (error.message !== 'no voice here') console.error('[voice]', error.message);
      if (id) await game.voiceStart(id, est);
      await new Promise(r => setTimeout(r, est));
    } finally { if (id) await game.voiceDone(id); }
  }
  playing = false;
}

function startGame(n = 2) { if (phase === 'playing') return; players = n; phase = 'playing'; brain.note(`Game started with ${n} player(s).`); void game.start(n); }
const brain = new Brain({ game, startGame, playersNow: () => players, phase: () => phase });

game.events.on('event', event => {
  if (event.type === 'say') { console.log(`  ${event.who === 'mabel' ? 'MABEL' : 'CHERT'}: ${event.text}`); lines.push(event); brain.heardChert(event.who, event.text); void speakLoop(); }
  else if (event.type === 'entered') brain.note(`P${event.player + 1} entered the ${event.room}`);
  else if (event.type === 'search') brain.note(`P${event.player + 1} searched the ${event.spot}: ${event.found || 'nothing'}`);
  else if (event.type === 'gesture' && event.action === 'ready' && phase === 'lobby') startGame(1);
  else if (event.type === 'game_over') { phase = 'over'; brain.note('Game over.'); }
  if (['clue', 'search', 'encounter', 'caught', 'win', 'game_over', 'challenge_start'].includes(event.type)) console.log('  [game]', JSON.stringify(event));
});

await game.say('chert', 'Oh thank goodness, you picked up! It’s me, Chert. I’m in trouble — Mabel stole my spark stone. Can you help me?');
console.log('\nType as a player:  1 solo (start one player)   1 ready (start two)   1 left   1 !motion   quit\n');

const rl = createInterface({ input: process.stdin });
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) continue;
  if (/^(quit|exit)$/i.test(line)) break;
  const m = line.match(/^([12])\s+(.+)$/);
  if (!m) { console.log('  Start with 1 or 2, e.g. "1 left" or "2 what do we do?"'); continue; }
  const player = +m[1] - 1, text = m[2];
  if (text.startsWith('!')) { console.log('  ->', await game.signal(player, text.slice(1))); continue; }
  if (phase !== 'playing') {
    if (/\bsolo\b/i.test(text)) { startGame(1); continue; }
    if (/\b(ready|start|play again|yes|yeah|sure|okay)\b/i.test(text)) { startGame(2); continue; }
    await brain.hear(player, text, 'lobby'); continue;
  }
  const result = await game.command(player, text.toLowerCase());
  if (['picked', 'passed', 'failed'].includes(result)) { console.log(`  -> ${result}`); brain.note(`P${player + 1} said "${text}" -> ${result}`); continue; }
  await brain.hear(player, text, result);
}
await game.close();
process.exit(0);
