// Syntax-checks the module script inside game/index.html. The page is one large
// HTML file, so `node --check` cannot see it without extracting the script first.
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = await readFile(fileURLToPath(new URL('../game/index.html', import.meta.url)), 'utf8');
const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1) {
  console.error(`expected one module script in game/index.html, found ${scripts.length}`);
  process.exit(1);
}
const file = join(tmpdir(), `chertbusters-page-${process.pid}.mjs`);
await writeFile(file, scripts[0][1]);
try {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  console.log('game/index.html module syntax ok');
} finally {
  await unlink(file).catch(() => {});
}
