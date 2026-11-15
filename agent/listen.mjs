// Hearing and seeing each caller.
// listenAudio: cuts a caller's audio into short phrases, sends each phrase to OpenAI speech to text, and also reports
//   loud sounds (laughing) for the "don't laugh" challenge.
// watchVideo: reads the FaceTime window capture, finds each caller tile, and sends per-tile JPEGs and motion/brightness
//   samples to the game. No model is used for video on the agent: the page does face and hand tracking.
import { AudioStream, VideoBufferType, VideoStream } from '@livekit/rtc-node';
import sharp from 'sharp';
import { detectTiles, parseRects, stabilizeTiles } from './tiles.mjs';

const ROTATE = [0, 90, 180, 270];

const RATE = 16000;
export const VOCAB = 'Chertbusters voice commands: left, right, forward, back, upstairs, downstairs, search the desk, wardrobe, bed, chest, bookshelf, piano, fireplace, safe, strike it, keys, light on, ready, play again, Batman, Spider-Man. Rooms: Foyer, Grand Hall, Study, Library, Kitchen, Dining Room, Parlor, Conservatory, Switchboard Room, Landing, Gallery, Nursery, Master Bedroom, Bathroom, Guest Room, Music Room, Sewing Room, Servants Quarters.';

export function listenAudio(track, { label, onText, onLoud }) {
  const stream = new AudioStream(track, { sampleRate: RATE, numChannels: 1 });
  let stopped = false, noise = 300, active = false, silentMs = 0, speechMs = 0, loudMs = 0;
  let speech = [], pre = [], preMs = 0;
  (async () => {
    for await (const frame of stream) {
      if (stopped) break;
      const d = frame.data, ms = (d.length / RATE) * 1000;
      let sum = 0; for (const v of d) sum += v * v;
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

const STT_MODELS = () => [...new Set([process.env.STT_MODEL || 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'])];

async function transcribe(chunks) {
  const n = chunks.reduce((total, c) => total + c.length, 0);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  let o = 44; for (const c of chunks) for (let i = 0; i < c.length; i++) { wav.writeInt16LE(c[i], o); o += 2; }
  let last = new Error('speech to text failed');
  for (const model of STT_MODELS()) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'phrase.wav');
    form.append('model', model);
    form.append('language', 'en');
    form.append('prompt', VOCAB);
    form.append('response_format', 'json');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
    if (res.ok) {
      const text = ((await res.json()).text || '').trim();
      if (!text || text.length > 140 || /voice commands/i.test(text)) return '';   // ignore echoes of the prompt
      return text;
    }
    last = new Error(`speech to text failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    if (![400, 404].includes(res.status)) break;
  }
  throw last;
}

const TILE_RECTS = parseRects(process.env.TILE_RECTS);
const TILE_COUNT = Number(process.env.TILE_COUNT || 0) || 0;
const TILE_DEBUG = process.env.TILE_DEBUG === '1';

function layoutKey(boxes) {
  return boxes.map(b => `${b.id}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`).join('|');
}

function sampleLuma(y, w, box, prev) {
  const step = Math.max(4, Math.floor(Math.min(box.w, box.h) / 32));
  const sample = [];
  let sum = 0, n = 0;
  for (let yy = box.y; yy < box.y + box.h; yy += step) for (let xx = box.x; xx < box.x + box.w; xx += step) {
    const v = y[yy * w + xx];
    sample.push(v); sum += v; n++;
  }
  let motion = 0;
  if (prev && prev.length === sample.length) {
    for (const [i, v] of sample.entries()) motion += Math.abs(v - prev[i]);
    motion /= sample.length;
  }
  return { brightness: n ? sum / n : 0, motion, sample, width: box.w, height: box.h };
}

export async function tileJpeg(pixels, w, h, box, rotation) {
  let img = sharp(pixels, { raw: { width: w, height: h, channels: 4 } });
  if (rotation) img = img.rotate(rotation);
  else img = img.extract({ left: box.x, top: box.y, width: box.w, height: box.h });
  return img.resize({ width: 400, height: 400, fit: 'inside' }).jpeg({ quality: 72, chromaSubsampling: '4:2:0' }).toBuffer();
}

async function snapshotJpeg(pixels, w, h, boxes, rotation) {
  let img = sharp(pixels, { raw: { width: w, height: h, channels: 4 } });
  if (rotation) img = img.rotate(rotation);
  if (rotation) return img.jpeg({ quality: 84 }).toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${
    boxes.map((b, i) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#ffb020" stroke-width="4"/><text x="${b.x + 10}" y="${b.y + 30}" fill="#ffb020" font-family="monospace" font-size="26">${i + 1}${b.id !== i ? ` (id ${b.id})` : ''}</text>`).join('')
  }</svg>`;
  return img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 84 }).toBuffer();
}

// onTile(tileId, jpgBase64, tileIndex): one cropped caller tile.
// onSample(tileId, sample): per-tile brightness/motion.
// onSnapshot(jpgBuffer, meta): a full frame with boxes drawn, for debugging.
// onFrame(jpgBase64): legacy whole-frame path for a participant that sends its own camera track.
export function watchVideo(track, { label, onSample, onFrame, onTile, onTiles, onSnapshot }) {
  const stream = new VideoStream(track);
  const tiled = typeof onTile === 'function';
  const state = { stable: [], pending: [], pendingCount: 0, nextId: 1 };
  const samples = new Map();
  let stopped = false, size = '', lastSample = 0, lastSend = 0, sending = false, lastSnap = 0, snapping = false, lastDetect = 0, warnedRotation = false;
  (async () => {
    for await (const event of stream) {
      if (stopped) break;
      const now = Date.now();
      const rotation = ROTATE[event.rotation] || 0;
      const dims = `${event.frame.width}x${event.frame.height} rot ${rotation}`;
      if (dims !== size) { size = dims; console.log(`[video] camera from ${label}: ${dims}`); }
      const wantSample = now - lastSample >= 150;
      const wantJpeg = (tiled || onFrame) && !sending && now - lastSend >= 140;
      const wantSnap = !!onSnapshot && !snapping && now - lastSnap >= 3000;
      if (!wantSample && !wantJpeg && !wantSnap) continue;
      if (rotation && !warnedRotation) {
        warnedRotation = true;
        console.warn('[video] rotated caller video: tile splitting is off, the whole frame is one tile');
      }

      let fw = event.frame.width, fh = event.frame.height, y = null;
      if (!rotation) {
        let f = event.frame;
        if (f.type !== VideoBufferType.I420) f = f.convert(VideoBufferType.I420);
        fw = f.width; fh = f.height; y = f.data;
      }

      let boxes = state.stable;
      if (tiled && !rotation && y && (now - lastDetect >= 900 || !boxes.length)) {
        lastDetect = now;
        const detected = detectTiles(y, fw, fh, { rects: TILE_RECTS, count: TILE_COUNT });
        const before = layoutKey(boxes);
        boxes = stabilizeTiles(state, detected, fw, fh);
        if (layoutKey(boxes) !== before) {
          console.log(`[video] ${boxes.length} caller tile${boxes.length === 1 ? '' : 's'}: ${boxes.map(b => `${Math.round(b.x / fw * 100)}%,${Math.round(b.y / fh * 100)}% ${Math.round(b.w / fw * 100)}x${Math.round(b.h / fh * 100)}%`).join(' | ')}`);
          onTiles?.(boxes);
        }
      } else if (tiled && rotation) {
        boxes = [{ id: 0, x: 0, y: 0, w: fw, h: fh, fallback: true }];
        if (!state.stable.length) { state.stable = boxes; onTiles?.(boxes); }
      } else if (tiled && !boxes.length) {
        boxes = [{ id: 0, x: 0, y: 0, w: fw, h: fh, fallback: true }];
      }

      if (wantSample && y) {
        lastSample = now;
        for (const [index, box] of boxes.entries()) {
          const prev = samples.get(box.id)?.prev;
          const s = sampleLuma(y, fw, box, prev);
          samples.set(box.id, { prev: s.sample });
          onSample?.(box.id, { brightness: s.brightness, motion: s.motion, width: s.width, height: s.height }, index);
        }
      }

      if (wantJpeg) {
        lastSend = now; sending = true;
        try {
          const rgba = event.frame.convert(VideoBufferType.RGBA);
          const pixels = Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
          if (tiled) {
            const jobs = boxes.map((box, index) => tileJpeg(pixels, rgba.width, rgba.height, box, rotation)
              .then(jpg => onTile(box.id, jpg.toString('base64'), index))
              .catch(error => { if (TILE_DEBUG) console.error('[video] tile encode failed:', error.message); }));
            await Promise.all(jobs);
          } else if (onFrame) {
            const jpg = await sharp(pixels, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
              .rotate(rotation).resize({ width: 480, height: 480, fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
            onFrame(jpg.toString('base64'));
          }
        } catch (error) {
          if (TILE_DEBUG) console.error('[video] frame encode failed:', error.message);
        } finally { sending = false; }
      }

      if (wantSnap) {
        lastSnap = now; snapping = true;
        try {
          const rgba = event.frame.convert(VideoBufferType.RGBA);
          const pixels = Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
          const jpg = await snapshotJpeg(pixels, rgba.width, rgba.height, boxes, rotation);
          onSnapshot(jpg, { width: rgba.width, height: rgba.height, tiles: boxes });
        } catch (error) {
          if (TILE_DEBUG) console.error('[video] snapshot failed:', error.message);
        } finally { snapping = false; }
      }
    }
  })().catch(error => { if (!stopped) console.error('[listen] video stopped for', label, error.message); });
  return () => { stopped = true; stream.cancel().catch(() => {}); };
}
