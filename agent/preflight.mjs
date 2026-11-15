// Run this on the Mac that will host the game, before the call:
//   npm run preflight
//
// It checks the runtime and the local files the page needs. It never prints a
// secret. A missing item is a hard failure except for .env.local and the keys,
// which are warnings so the check is useful before setup is finished.
import './logging.mjs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = join(HERE, '..');
const checks = [];
const warning = (label, detail) => checks.push({ level: 'warn', label, detail });
const fail = (label, detail) => checks.push({ level: 'fail', label, detail });
const pass = (label, detail = '') => checks.push({ level: 'ok', label, detail });

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 12)) pass('Node', process.versions.node);
else fail('Node', `${process.versions.node}; install Node 22.12+ or 24`);

for (const [label, path] of [
  ['game page', join(root, 'game', 'index.html')],
  ['gesture classifier', join(root, 'game', 'gestures.js')],
  ['Three.js', join(root, 'game', 'vendor', 'three.module.js')],
  ['IM Fell font', join(root, 'game', 'vendor', 'fonts', 'im-fell-english-sc-latin-400-normal.woff2')],
  ['Special Elite font', join(root, 'game', 'vendor', 'fonts', 'special-elite-latin-400-normal.woff2')],
  ['MediaPipe Hands', join(HERE, 'node_modules', '@mediapipe', 'hands', 'hands.js')],
  ['MediaPipe FaceMesh', join(HERE, 'node_modules', '@mediapipe', 'face_mesh', 'face_mesh.js')],
  ['MediaPipe SelfieSegmentation', join(HERE, 'node_modules', '@mediapipe', 'selfie_segmentation', 'selfie_segmentation.js')],
]) {
  if (await exists(path)) pass(label);
  else fail(label, path);
}

try {
  const executable = process.env.CHROME_PATH || chromium.executablePath();
  if (await exists(executable)) pass(process.env.CHROME_PATH ? 'Chromium (CHROME_PATH)' : 'Playwright Chromium', executable);
  else fail('Playwright Chromium', `${executable}; run npx playwright install chromium or set CHROME_PATH`);
} catch (error) {
  fail('Playwright Chromium', `${error.message}; run npx playwright install chromium or set CHROME_PATH`);
}

const envFile = join(HERE, '.env.local');
if (await exists(envFile)) {
  pass('.env.local');
  const text = await readFile(envFile, 'utf8').catch(() => '');
  for (const key of ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'AGENT_NAME']) {
    const re = new RegExp(`^${key}=(.+)$`, 'm');
    const value = text.match(re)?.[1]?.trim();
    if (value && !/^YOUR_/.test(value)) pass(key, 'set');
    else warning(key, 'not set in .env.local');
  }
  for (const key of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
    const re = new RegExp(`^${key}=(.+)$`, 'm');
    const value = text.match(re)?.[1]?.trim();
    if (value && !/^YOUR_/.test(value)) pass(key, 'set (own LiveKit project)');
  }
} else {
  warning('.env.local', 'copy .env.example to .env.local and fill it in');
}

let failed = false;
for (const c of checks) {
  console.log(`${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} ${c.label}${c.detail ? `  ${c.detail}` : ''}`);
  if (c.level === 'fail') failed = true;
}
if (failed) {
  console.error('\nFix the ✗ items, then run npm run preflight again.');
  process.exit(1);
}
console.log('\nReady. Next: npm run preview (no call), then npm start plus chert dev.');
