// Runs the Dead Line page in a hidden Chrome window and turns it into video frames.
// The page is the whole picture the callers see: Chert full screen, then the game, then Chert again.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Publish a square camera frame so FaceTime's square Fill view preserves both players.
// Keep the browser layout wide and letterbox it during decoding, not in the game UI.
export const WIDTH = 1280;
export const HEIGHT = 1280;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const TYPES = { '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.binarypb': 'application/octet-stream', '.tflite': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

const MEDIAPIPE = resolve(join(import.meta.dirname, 'node_modules', '@mediapipe'));

// Serves the game folder, plus /mp/ = MediaPipe's face and person tracking from node_modules.
async function serve(dir, development) {
  const root = resolve(dir);
  let vite;
    const server = createServer(async (req, res) => {
      try {
        let path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
        if (vite && !path.startsWith('/mp/')) { vite.middlewares(req,res); return; }
        if (path.endsWith('/')) path += 'index.html';
        const base = path.startsWith('/mp/') ? MEDIAPIPE : root;
        const file = normalize(join(base, path.startsWith('/mp/') ? path.slice(3) : path));
        if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
      } catch { res.writeHead(404).end(); }
    });
  if (development) {
    vite = await (await import('vite')).createServer({
      configFile:false, root, appType:'spa',
      server:{ middlewareMode:true, hmr:{server}, watch:{ignored:['**/node_modules/**']} },
    });
    server.on('close', () => { void vite.close(); });
  }
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  return server;
}

/**
 * Opens the game. `show: true` opens a visible window (handy on your Mac); otherwise it runs hidden.
 * Returns controls for the game plus latestFrame(), which gives the newest picture as RGBA pixels.
 */
export async function openGame({ dir, show = false, query = '' }) {
  console.log('[game] opening browser', { show, camera:query.includes('localcam'), dryRun:query.includes('dryrun=1'), softwareGL:process.env.GAME_SOFTWARE_GL === '1' });
  const server = await serve(dir, show);
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
  // Visible dry runs must follow the real window; an emulated viewport ignores manual resizing.
  const page = await browser.newPage(show && query.includes('dryrun=1') ? { viewport:null } : { viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1 });
  const events = new EventEmitter();
  page.on('pageerror', error => console.error('[game] page error:', error.message));
  page.on('crash', () => { console.error('[game] the game page crashed'); events.emit('crash'); });
  page.on('console', message => {
    const level = message.type();
    if (level === 'error') console.error('[browser]', message.text());
    else if (level === 'warning') console.warn('[browser]', message.text());
    else console.log(`[browser:${level}]`, message.text());
  });
  page.on('requestfailed', request => console.warn('[browser] request failed', request.method(), new URL(request.url()).pathname, request.failure()?.errorText));
  page.on('response', response => { if (response.status() >= 400) console.warn('[browser] HTTP error', response.status(), new URL(response.url()).pathname); });
  browser.on('disconnected', () => console.log('[game] browser disconnected'));
  await page.exposeFunction('__deadlineEvent', event => events.emit('event', event));
  // Full-page Vite updates create a new document; reconnect the event bridge on every load.
  await page.addInitScript(() => {
    const connect = () => {
      if (window.deadLine) window.deadLine.on(event => window.__deadlineEvent(event));
      else setTimeout(connect,25);
    };
    connect();
  });
  await page.goto(`http://127.0.0.1:${port}/index.html?view=call${query}`);
  await page.waitForFunction(() => window.deadLine && window.deadLine.view === 'call', null, { timeout: 30_000 });
  console.log('[game] page ready', { viewport:page.viewportSize() });

  // Chrome streams the page as JPEG frames. Keep the newest one and decode it only when a frame is sent.
  const cdp = await page.context().newCDPSession(page);
  let jpeg = null, jpegId = 0, rgba = Buffer.alloc(WIDTH * HEIGHT * 4), rgbaId = -1, decoding = null;
  const counts = { received: 0, decoded: 0 };
  cdp.on('Page.screencastFrame', frame => {
    jpeg = frame.data; jpegId++; counts.received++;
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEWPORT_WIDTH, maxHeight: VIEWPORT_HEIGHT, everyNthFrame: 1 });
  let previousFrames = 0, previousDecoded = 0, previousCpu = process.cpuUsage(), previousSample = performance.now();
  const diagnosticTimer = setInterval(() => {
    const now = performance.now(), elapsed = (now - previousSample) / 1000;
    const cpu = process.cpuUsage(), memory = process.memoryUsage();
    console.log('[game] performance', {
      capturedFps:Number(((counts.received - previousFrames) / elapsed).toFixed(1)),
      decodedFps:Number(((counts.decoded - previousDecoded) / elapsed).toFixed(1)),
      nodeCpuPercent:Number(((cpu.user + cpu.system - previousCpu.user - previousCpu.system) / (elapsed * 10000)).toFixed(1)),
      nodeRssMB:Math.round(memory.rss / 1048576), uptimeSeconds:Math.round(process.uptime()),
    });
    previousFrames = counts.received; previousDecoded = counts.decoded; previousCpu = cpu; previousSample = now;
  }, 10000);
  diagnosticTimer.unref();
  browser.on('disconnected', () => clearInterval(diagnosticTimer));

  function latestFrame() {
    if (jpeg && rgbaId !== jpegId && !decoding) {
      const id = jpegId;
      decoding = sharp(Buffer.from(jpeg, 'base64')).resize(WIDTH, HEIGHT, { fit: 'contain', position: 'centre', background: '#000000' }).ensureAlpha().raw().toBuffer()
        .then(buffer => { if (buffer.length === WIDTH * HEIGHT * 4) { rgba = buffer; rgbaId = id; counts.decoded++; } })
        .catch(error => console.error('[game] frame decode failed:', error.message))
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
      console.log('[game] reloading page');
      await page.reload();
      await page.waitForFunction(() => window.deadLine && window.deadLine.view === 'call', null, { timeout: 30_000 });
    },
    async close() {
      console.log('[game] closing browser and server');
      clearInterval(diagnosticTimer);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await browser.close().catch(() => {});
      server.close();
    },
  };
}
