import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const OUT = process.argv[2], ROOT = join(import.meta.dirname, '..', 'game');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const srv = createServer(async (q, r) => { let body; let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p === '/') p = '/index.html'; try { body = await readFile(join(ROOT, p)); } catch { r.writeHead(404).end(); return; } r.writeHead(200, { 'content-type': T[extname(p)] || 'application/octet-stream' }).end(body); });
await new Promise(d => srv.listen(0, d));
const wait = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
page.on('pageerror', e => console.error('ERR', e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/index.html?view=call&debug&skipintro&speed=1&nograin`);
await page.waitForFunction(() => window.deadLine);
await page.addStyleTag({ content: '#top,.opts,.guide,.where,.handchip,.bubble,#caption,.toast,#objs,.maps,.mapw,#grain,.banner,#callCap,.items,.heard,#hostBanner,#timer,.stamp,.dead,.frameP{display:none!important} .half .tag{transform:scale(1.4);transform-origin:0 0}' });
const shot = async (name, sel = '#halves') => { await wait(4000); await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 94, timeout: 120000 }); console.log('shot', name); };
await page.evaluate(() => deadLine.start(1)); for (let i = 0; i < 120; i++) { const st = await page.evaluate(() => deadLine.state()); if (st.players && st.players.length && st.phase && st.phase !== 'intro') break; await wait(500); } await wait(4000);
const sec = await page.evaluate(() => { const d = deadLine.debug(); return { key: d.keyRoom, stone: d.stone }; }); console.log(sec);
for (const room of ['hall', 'study', 'landing', sec.stone]) {
  await page.evaluate(r => { deadLine.debug().travelTo(0, r); deadLine.debug().setGhost('nowhere'); }, room); await shot(`r_${room}`);
}
await page.evaluate(r => { deadLine.debug().travelTo(0, r); deadLine.debug().giveKey(0); }, sec.stone); await shot('r_stone_key');
await page.evaluate(() => { const d = deadLine.debug(); d.travelTo(0, 'hall'); d.setGhost('hall'); }); await shot('r_ghost');
await page.reload(); await page.waitForFunction(() => window.deadLine);
await page.addStyleTag({ content: '#top,.opts,.guide,.where,.handchip,.bubble,#caption,.toast,#objs,.maps,.mapw,#grain,.banner,#callCap,.items,.heard,#hostBanner,#timer,.stamp,.dead,.frameP{display:none!important}' });
await page.evaluate(() => deadLine.start(2)); for (let i = 0; i < 120; i++) { const st = await page.evaluate(() => deadLine.state()); if (st.players && st.players.length && st.phase && st.phase !== 'intro') break; await wait(500); } await wait(4000);
await page.evaluate(() => { const d = deadLine.debug(); d.travelTo(0, 'study'); d.travelTo(1, 'landing'); d.setGhost('nowhere'); }); await shot('split');
await b.close(); srv.close(); process.exit(0);
