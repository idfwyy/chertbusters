// Hearing and seeing each caller.
// listenAudio: cuts a caller's audio into short phrases, sends each phrase to OpenAI speech to text, and also reports
//   loud sounds (laughing) for the "don't laugh" challenge.
// watchVideo: samples a caller's camera a few times a second and reports how much the picture moved and how bright it is,
//   for the "please hold" (freeze) and "blackout" (turn on a light) challenges. No model is used for video.
import { AudioStream, VideoBufferType, VideoStream } from '@livekit/rtc-node';
import sharp from 'sharp';

const ROTATE = [0, 90, 180, 270];

const RATE = 16000;
export const VOCAB = 'Dead Line voice commands: left, right, forward, back, upstairs, downstairs, search the desk, wardrobe, bed, chest, bookshelf, piano, fireplace, safe, hello, strike it, keys, light on, ready, play again, orange, blue. Rooms: Foyer, Grand Hall, Study, Library, Kitchen, Dining Room, Parlor, Conservatory, Switchboard Room, Landing, Gallery, Nursery, Master Bedroom, Bathroom, Guest Room, Music Room, Sewing Room, Servants Quarters.';

export function listenAudio(track, { label, onText, onLoud }) {
  const stream = new AudioStream(track, { sampleRate: RATE, numChannels: 1 });
  let stopped = false, noise = 300, active = false, silentMs = 0, speechMs = 0, loudMs = 0;
  let speech = [], pre = [], preMs = 0;
  (async () => {
    for await (const frame of stream) {
      if (stopped) break;
      const d = frame.data, ms = (d.length / RATE) * 1000;
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      if (!active) noise = noise * 0.995 + Math.min(rms, noise * 2) * 0.005;
      const threshold = Math.max(450, noise * 3);
      loudMs = rms > threshold * 1.6 ? loudMs + ms : Math.min(loudMs, 0);
      if (loudMs >= 250) { onLoud?.(); loudMs = -1500; }
      const copy = Int16Array.from(d);
      if (rms > threshold) {
        if (!active) { active = true; speech = pre.slice(); speechMs = 0; }
        silentMs = 0;
      }
      if (active) {
        speech.push(copy); speechMs += ms;
        if (rms <= threshold) silentMs += ms;
        if (silentMs > 550 || speechMs > 6000) {
          active = false;
          const clip = speech, voiced = speechMs - silentMs;
          speech = [];
          if (voiced > 180) transcribe(clip).then(text => { if (text) onText(text); }).catch(error => console.error('[listen]', label, error.message));
        }
      } else {
        pre.push(copy); preMs += ms;
        while (preMs > 300 && pre.length > 1) { preMs -= (pre[0].length / RATE) * 1000; pre.shift(); }
      }
    }
  })().catch(error => { if (!stopped) console.error('[listen] audio stopped for', label, error.message); });
  return () => { stopped = true; stream.cancel().catch(() => {}); };
}

async function transcribe(chunks) {
  const n = chunks.reduce((total, c) => total + c.length, 0);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  let o = 44; for (const c of chunks) for (let i = 0; i < c.length; i++) { wav.writeInt16LE(c[i], o); o += 2; }
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'phrase.wav');
  form.append('model', process.env.STT_MODEL || 'gpt-4o-mini-transcribe');
  form.append('language', 'en');
  form.append('prompt', VOCAB);
  form.append('response_format', 'json');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  if (!res.ok) throw new Error(`speech to text failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const text = ((await res.json()).text || '').trim();
  if (!text || text.length > 140 || /voice commands/i.test(text)) return '';   // ignore echoes of the prompt
  return text;
}

// onFrame gets a small JPEG (base64) of the caller's camera about 7 times a second, for the game's Mabel filter.
export function watchVideo(track, { label, onSample, onFrame }) {
  const stream = new VideoStream(track);
  let stopped = false, prev = null, last = 0, lastSend = 0, sending = false;
  (async () => {
    for await (const event of stream) {
      if (stopped) break;
      const now = Date.now();
      if (onFrame && !sending && now - lastSend > 140) {
        lastSend = now; sending = true;
        try {
          const rgba = event.frame.convert(VideoBufferType.RGBA);
          const pixels = Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
          sharp(pixels, { raw: { width: rgba.width, height: rgba.height, channels: 4 } }).rotate(ROTATE[event.rotation] || 0)
            .resize({ width: 480, height: 480, fit: 'inside' }).jpeg({ quality: 72 }).toBuffer()
            .then(jpg => onFrame(jpg.toString('base64'))).catch(() => {}).finally(() => { sending = false; });
        } catch { sending = false; }
      }
      if (now - last < 150) continue;
      last = now;
      let f = event.frame;
      if (f.type !== VideoBufferType.I420) f = f.convert(VideoBufferType.I420);
      const { width: w, height: h, data: y } = f;
      const step = Math.max(4, Math.floor(w / 64));
      const sample = []; let sum = 0;
      for (let yy = 0; yy < h; yy += step) for (let xx = 0; xx < w; xx += step) { const v = y[yy * w + xx]; sample.push(v); sum += v; }
      let motion = 0;
      if (prev && prev.length === sample.length) { for (let i = 0; i < sample.length; i++) motion += Math.abs(sample[i] - prev[i]); motion /= sample.length; }
      prev = sample;
      onSample({ brightness: sum / sample.length, motion });
    }
  })().catch(error => { if (!stopped) console.error('[listen] video stopped for', label, error.message); });
  return () => { stopped = true; stream.cancel().catch(() => {}); };
}
