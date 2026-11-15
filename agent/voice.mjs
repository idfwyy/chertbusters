// Chert's and Mabel's voices, played into the call as the agent's one audio track.
// - ElevenLabs when ELEVENLABS_API_KEY is set, OpenAI text to speech as the backup, a beep if both fail
//   (Chert ends calls that stay silent).
// - Every line is saved in voice-cache/ the first time, so fixed lines play instantly and never cost credits twice.
//   prewarm() records the game's fixed lines before anyone calls.
// - Mabel's and challenge lines are urgent: they cut off Chert's chatter and skip the queue.
// - onStart(id, ms) / onDone(id) tell the game when a line really starts and finishes, so the picture waits for the voice.
import { AudioFrame, AudioSource } from '@livekit/rtc-node';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SAMPLE_RATE = 24000;            // 24 kHz, 16-bit, mono from both providers
const FRAME = SAMPLE_RATE / 50;              // 20 ms
const CACHE = join(dirname(fileURLToPath(import.meta.url)), 'voice-cache');

// ElevenLabs voice IDs. Pick your own in ElevenLabs (Voices > ... > Copy voice ID) and put them in .env.local.
const ELEVEN = {
  chert: process.env.CHERT_VOICE_ID || 'TxGEqnHWrfWFTfGW9XjX',
  mabel: process.env.MABEL_VOICE_ID || 'z9fAnlkpzviPz146aGWa',
};
const ELEVEN_SETTINGS = {
  chert: { stability: 0.35, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true, speed: 1.08 },
  mabel: { stability: 0.6, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true, speed: 0.85 },
};
const OPENAI = {
  chert: { voice: 'ash', instructions: 'You are Chert, a small friendly talking stone who runs a phone line. Speak quickly and warmly, a little nervous, like a buddy on a crackly phone call.' },
  mabel: { voice: 'shimmer', instructions: 'You are Mabel, the ghost of a 1926 telephone switchboard operator. Speak slowly in a breathy, sing-song, unsettling whisper.' },
};

async function eleven(who, text, file) {
  const format = file ? 'mp3_44100_128' : 'pcm_24000';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN[who] || ELEVEN.chert}/stream?output_format=${format}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: process.env.ELEVEN_MODEL || 'eleven_flash_v2_5', voice_settings: ELEVEN_SETTINGS[who] || ELEVEN_SETTINGS.chert }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { res, ext: 'mp3' };
}

async function openai(who, text, file) {
  const v = OPENAI[who] || OPENAI.chert;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TTS_MODEL || 'gpt-4o-mini-tts', voice: v.voice, input: text, instructions: v.instructions, response_format: file ? 'wav' : 'pcm' }),
  });
  if (!res.ok) throw new Error(`OpenAI speech ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { res, ext: 'wav' };
}

/** Speech for one line. file=false: raw 24 kHz PCM for the call. file=true: an audio file for local playback. */
export async function synth(who, text, file = false) {
  const providers = [];
  if (process.env.ELEVENLABS_API_KEY) providers.push(eleven);
  if (process.env.OPENAI_API_KEY) providers.push(openai);
  let last = new Error('no voice key: add ELEVENLABS_API_KEY or OPENAI_API_KEY to .env.local');
  for (const provider of providers) {
    try { return await provider(who, text, file); }
    catch (error) { last = error; console.error('[voice]', error.message, providers.length > 1 ? '(trying the backup voice)' : ''); }
  }
  throw last;
}

const cacheKey = (who, text) => createHash('sha1').update(`${who}|${ELEVEN[who] || ''}|${process.env.ELEVENLABS_API_KEY ? 'el' : 'oa'}|${text}`).digest('hex');
async function readCache(who, text) { try { return await readFile(join(CACHE, cacheKey(who, text) + '.pcm')); } catch { return null; } }
async function writeCache(who, text, pcm) { try { await mkdir(CACHE, { recursive: true }); await writeFile(join(CACHE, cacheKey(who, text) + '.pcm'), pcm); } catch { /* cache is optional */ } }

/** Records lines ahead of time (two at a time), skipping ones already saved. */
export async function prewarm(lines) {
  let made = 0;
  const todo = [];
  for (const [who, text] of lines) if (!(await readCache(who, text))) todo.push([who, text]);
  const worker = async () => {
    while (todo.length) {
      const [who, text] = todo.shift();
      try { const { res } = await synth(who, text, false); await writeCache(who, text, Buffer.from(await res.arrayBuffer())); made++; }
      catch (error) { console.error('[voice] could not record a line ahead of time:', error.message); return; }
    }
  };
  await Promise.all([worker(), worker()]);
  if (made) console.log(`[voice] recorded ${made} lines ahead of time (saved in voice-cache/)`);
}

export class Voice {
  /** @param {{ onStart?: (id:number, ms:number) => void, onDone?: (id:number) => void }} hooks */
  constructor(hooks = {}) {
    this.source = new AudioSource(SAMPLE_RATE, 1, 400);
    this.hooks = hooks;
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.current = null;
    this.delayMs = +(process.env.VOICE_DELAY_MS || 0);   // add a little if the voice runs ahead of the picture
  }

  say(who, text, { id = 0, urgent = false } = {}) {
    if (this.closed || !text) { this.hooks.onDone?.(id); return; }
    const line = { who, text, id, urgent, at: Date.now() };
    if (urgent) {
      // Drop queued chatter, cut off a non-urgent line in progress, and go first.
      for (const old of this.queue.filter(l => !l.urgent)) this.hooks.onDone?.(old.id);
      this.queue = this.queue.filter(l => l.urgent);
      if (this.current && !this.current.urgent) { this.current.cut = true; this.source.clearQueue(); }
    }
    this.queue.push(line);
    void this.#pump();
  }

  async #pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && !this.closed) {
      const line = this.queue.shift();
      if (Date.now() - line.at > 8000 && this.queue.length && !line.urgent) { this.hooks.onDone?.(line.id); continue; }
      this.current = line;
      try { await this.#speak(line); }
      catch (error) { console.error('[voice]', error.message); await this.beep(); }
      finally { this.current = null; this.hooks.onDone?.(line.id); }
    }
    this.busy = false;
  }

  async #speak(line) {
    const { who, text } = line;
    if (this.delayMs) await this.#silence(this.delayMs);
    const cached = await readCache(who, text);
    if (cached) {
      this.hooks.onStart?.(line.id, (cached.length / 2 / SAMPLE_RATE) * 1000);
      for (let o = 0; o + 2 <= cached.length && !line.cut && !this.closed; o += FRAME * 2) await this.#push(cached, o);
    } else {
      const { res } = await synth(who, text, false);
      const chunks = [];
      let carry = Buffer.alloc(0), started = false;
      for await (const chunk of res.body) {
        if (line.cut || this.closed) break;
        const b = Buffer.from(chunk); chunks.push(b);
        if (!started) { started = true; this.hooks.onStart?.(line.id, text.length * 65); }
        carry = Buffer.concat([carry, b]);
        while (carry.length >= FRAME * 2 && !line.cut) { await this.#push(carry, 0); carry = carry.subarray(FRAME * 2); }
      }
      if (carry.length >= 2 && !line.cut) await this.#push(carry, 0);
      if (!line.cut) void writeCache(who, text, Buffer.concat(chunks));
    }
    if (!line.cut && !this.closed) await this.source.waitForPlayout();
  }

  async #push(buf, offset) {
    const pcm = new Int16Array(FRAME);
    const n = Math.min(FRAME, Math.floor((buf.length - offset) / 2));
    for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(offset + i * 2);
    await this.source.captureFrame(new AudioFrame(pcm, SAMPLE_RATE, 1, FRAME));
  }

  async #silence(ms) { for (let t = 0; t < ms; t += 20) await this.source.captureFrame(new AudioFrame(new Int16Array(FRAME), SAMPLE_RATE, 1, FRAME)); }

  async beep() {
    for (let k = 0; k < 15 && !this.closed; k++) {
      const pcm = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i++) pcm[i] = Math.sin(((k * FRAME + i) / SAMPLE_RATE) * 2 * Math.PI * 660) * 5000;
      await this.source.captureFrame(new AudioFrame(pcm, SAMPLE_RATE, 1, FRAME));
    }
  }

  async close() {
    this.closed = true;
    for (const l of this.queue) this.hooks.onDone?.(l.id);
    this.queue.length = 0;
    await this.source.close?.();
  }
}
