// Runs the Dead Line page in a hidden Chrome window and turns it into video frames.
// The page is the whole picture the callers see: Chert full screen, then the game, then Chert again.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import sharp from 'sharp';

export const WIDTH = 1280;
export const HEIGHT = 720;
const TYPES = { '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.binarypb': 'application/octet-stream', '.tflite': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

const MEDIAPIPE = resolve(join(import.meta.dirname, 'node_modules', '@mediapipe'));

// Serves the game folder, plus /mp/ = MediaPipe's face and person tracking from node_modules.
function serve(dir) {
  const root = resolve(dir);
  return new Promise(done => {
    const server = createServer(async (req, res) => {
      try {
        let path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
        if (path.endsWith('/')) path += 'index.html';
        const base = path.startsWith('/mp/') ? MEDIAPIPE : root;
        const file = normalize(join(base, path.startsWith('/mp/') ? path.slice(3) : path));
        if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
      } catch { res.writeHead(404).end(); }
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

/**
 * Opens the game. `show: true` opens a visible window (handy on your Mac); otherwise it runs hidden.
 * Returns controls for the game plus latestFrame(), which gives the newest picture as RGBA pixels.
 */
export async function openGame({ dir, show = false, query = '' }) {
  const server = await serve(dir);
  const { port } = server.address();
  const args = [
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    // The game is a hidden or covered window. Chromium throttles those unless told not to.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ];
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  if (show && query.includes('localcam')) args.push('--use-fake-ui-for-media-stream');
  if (process.env.GAME_SOFTWARE_GL === '1') args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const browser = await chromium.launch({ headless: !show, args, executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const events = new EventEmitter();
  page.on('pageerror', error => console.error('[game] page error:', error.message));
  page.on('crash', () => { console.error('[game] the game page crashed'); events.emit('crash'); });
  page.on('console', message => { if (message.type() === 'error') console.error('[game]', message.text()); });
  await page.exposeFunction('__deadlineEvent', event => events.emit('event', event));
  await page.goto(`http://127.0.0.1:${port}/index.html?view=call${query}`);
  await page.waitForFunction(() => window.deadLine && window.deadLine.view === 'call', null, { timeout: 30_000 });
  await page.evaluate(() => window.deadLine.on(event => window.__deadlineEvent(event)));

  // Chrome streams the page as JPEG frames. Keep the newest one and decode it only when a frame is sent.
  const cdp = await page.context().newCDPSession(page);
  let jpeg = null, jpegId = 0, rgba = Buffer.alloc(WIDTH * HEIGHT * 4), rgbaId = -1, decoding = null;
  const counts = { received: 0, decoded: 0 };
  cdp.on('Page.screencastFrame', frame => {
    jpeg = frame.data; jpegId++; counts.received++;
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

  function latestFrame() {
    if (jpeg && rgbaId !== jpegId && !decoding) {
      const id = jpegId;
      decoding = sharp(Buffer.from(jpeg, 'base64')).resize(WIDTH, HEIGHT, { fit: 'fill' }).ensureAlpha().raw().toBuffer()
        .then(buffer => { if (buffer.length === WIDTH * HEIGHT * 4) { rgba = buffer; rgbaId = id; counts.decoded++; } })
        .catch(() => {})
        .finally(() => { decoding = null; });
    }
    return rgba;
  }

  // start() and say() return promises that last a whole game or line; never wait on them here.
  const call = (fn, ...args) => page.evaluate(([fn, args]) => { const r = window.deadLine[fn](...args); return r && typeof r.then === 'function' ? null : r; }, [fn, args])
    .catch(error => { console.error(`[game] ${fn} failed:`, error.message); });

  return {
    events,
    latestFrame,
    start: (players, options) => call('start', players, options),
    cam: (player, jpg) => call('cam', player, jpg),
    command: (player, text) => call('command', player, text),
    heard: (player, text) => call('heard', player, text),
    prompt: text => call('prompt', text),
    voiceStart: (id, ms) => call('voiceStart', id, ms),
    voiceDone: id => call('voiceDone', id),
    scriptLines: () => page.evaluate(() => window.deadLine.scriptLines()).catch(() => []),
    stats: () => ({ ...counts, reset() { counts.received = 0; counts.decoded = 0; } }),
    signal: (player, kind) => call('signal', player, kind),
    say: (who, text) => call('say', who, text),
    // Unlike say(), this waits for the page's voice-sync promise. Use it only when the
    // next step must happen after the line is actually heard (the lobby greeting).
    sayWait: (who, text) => page.evaluate(([w, t]) => window.deadLine.say(w, t), [who, text]).catch(() => null),
    choose: (player, key) => call('choose', player, key),
    secrets: () => page.evaluate(() => window.deadLine.secrets()).catch(() => null),
    state: () => page.evaluate(() => window.deadLine.state()),
    handState: () => page.evaluate(() => window.deadLine.handState()).catch(() => []),
    faceState: () => page.evaluate(() => window.deadLine.faceState()).catch(() => []),
    speaking: () => page.evaluate(() => window.deadLine.speaking()).catch(() => []),
    hint: (player, item) => page.evaluate(([p, i]) => window.deadLine.hint(p, i), [player, item]).catch(() => null),
    screenshot: path => page.screenshot({ path }),
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    // Reload after a crash: same page, fresh game, Chert full screen again.
    async reload() {
      await page.reload();
      await page.waitForFunction(() => window.deadLine && window.deadLine.view === 'call', null, { timeout: 30_000 });
      await page.evaluate(() => window.deadLine.on(event => window.__deadlineEvent(event)));
    },
    async close() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await browser.close().catch(() => {});
      server.close();
    },
  };
}
