// Adds an ElevenLabs narrator, sound effects and music to the Chertbusters demo video.
// Run from ~/ghost-house/agent:   node --env-file=.env.local addsound.mjs ~/Downloads/chertbusters-demo-hd.mp4
// Output: ~/Desktop/chertbusters-final.mp4
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import ffmpegPath from 'ffmpeg-static';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('No ELEVENLABS_API_KEY in .env.local'); process.exit(1); }
const VIDEO = process.argv[2] || join(homedir(), 'Downloads', 'chertbusters-demo-hd.mp4');
if (!existsSync(VIDEO)) { console.error('Video not found:', VIDEO); process.exit(1); }
const DIR = join(homedir(), 'Desktop', 'chertbusters-sound'); await mkdir(DIR, { recursive: true });
const OUT = join(homedir(), 'Desktop', 'chertbusters-final.mp4');
const NARRATOR = process.env.NARRATOR_VOICE_ID || 'nPczCjzI2devNBz1zQrb';   // deep, serious narrator
const H = { 'xi-api-key': KEY, 'content-type': 'application/json' };

// narrator lines placed on the video's cuts (seconds)
const LINES = [
  [0.25, 'Pick up.'], [1.45, 'It answers.'], [3.05, 'Your call becomes a game.'], [5.4, 'One call. Two players.'],
  [7.0, 'It sees you.'], [8.6, 'Point, and you move.'], [10.4, 'Close your hand, and you search.'],
  [12.1, 'Speak, and it listens.'], [13.9, 'Ask, and it answers.'], [16.0, 'Don’t. Move.'],
  [18.5, 'She’s behind you.'], [20.2, 'Raise your palm.'], [22.0, 'Strike it.'], [24.1, 'Chertbusters.'], [25.5, 'FaceTime is the game.'],
];
// sound effects: [file, prompt, length in s, [times], volume]
const SFX = [
  ['ring', 'single vintage rotary telephone ring, eerie, dry, close', 1.6, [0.0], 0.7],
  ['boom', 'deep cinematic trailer boom impact hit with long dark reverb tail', 3.0, [4.6, 15.7, 23.6], 0.9],
  ['scan', 'short futuristic digital scan glitch sound', 1.0, [6.6], 0.6],
  ['heart', 'fast heavy tense heartbeat', 2.0, [15.7], 0.8],
  ['whisper', 'creepy female ghost whisper breath, very close', 1.6, [17.6], 0.9],
  ['push', 'low magical energy pulse blast pushing outward', 1.4, [20.4], 0.7],
];
const MUSIC_PROMPT = 'Dark cinematic trailer score, 28 seconds. Low eerie drone and slow pulsing synth bass that steadily builds tension with ticking percussion and tense strings, louder and faster until 17 seconds, then sudden silence, then a dark haunted drone rising again to a final huge hit at 24 seconds and a long reverb tail. No vocals.';

async function save(res, file) { if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`); await writeFile(file, Buffer.from(await res.arrayBuffer())); return file; }
const tts = (text, file) => save(fetch(`https://api.elevenlabs.io/v1/text-to-speech/${NARRATOR}?output_format=mp3_44100_128`, { method: 'POST', headers: H, body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, speed: 1.0 } }) }).then(r => r), file);
const sfx = (text, sec, file) => fetch('https://api.elevenlabs.io/v1/sound-generation', { method: 'POST', headers: H, body: JSON.stringify({ text, duration_seconds: sec, prompt_influence: 0.5 }) }).then(r => save(r, file));

const clips = [];
console.log('Making narrator lines…');
for (const [i, [at, text]] of LINES.entries()) { const f = join(DIR, `v${i}.mp3`); await tts(text, f).then(() => clips.push({ f, at, vol: 1.0 })).catch(e => console.error('voice', text, e.message)); }
console.log('Making sound effects…');
for (const [name, prompt, sec, times, vol] of SFX) { const f = join(DIR, `${name}.mp3`); try { await sfx(prompt, sec, f); times.forEach(at => clips.push({ f, at, vol })); } catch (e) { console.error('sfx', name, e.message); } }
console.log('Making music…');
let music = join(DIR, 'music.mp3');
try { await save(await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', { method: 'POST', headers: H, body: JSON.stringify({ prompt: MUSIC_PROMPT, music_length_ms: 28000 }) }), music); }
catch (e) {
  console.error('music API not available on this plan, using a sound-effect drone instead:', e.message);
  try { await sfx('dark cinematic drone, tense low rumble, building suspense', 22, music); } catch (e2) { console.error('drone failed', e2.message); music = null; }
}

console.log('Mixing…');
const args = ['-y', '-loglevel', 'error', '-i', VIDEO];
if (music) args.push('-stream_loop', '1', '-i', music);
clips.forEach(c => args.push('-i', c.f));
const parts = [], labels = [];
let idx = 1;
if (music) { parts.push(`[1:a]atrim=0:28,afade=t=in:d=0.5,afade=t=out:st=26.5:d=1.5,volume=0.35[m]`); labels.push('[m]'); idx = 2; }
clips.forEach((c, i) => { const ms = Math.round(c.at * 1000); parts.push(`[${idx + i}:a]adelay=${ms}|${ms},volume=${c.vol}[c${i}]`); labels.push(`[c${i}]`); });
parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,atrim=0:28,loudnorm=I=-15:TP=-1.5[a]`);
args.push('-filter_complex', parts.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT);
execFileSync(ffmpegPath, args, { stdio: 'inherit' });
console.log('\nDone:', OUT);
