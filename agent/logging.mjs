// Per-run terminal log for chertbusters. Import this first in an entrypoint:
// importing starts logging. Every process writes one exclusive file under
// <repository>/logs/, independent of the working directory. stdout and stderr
// are mirrored there with timestamps; known secret values, bearer and
// authorization tokens, credential-shaped keys, and media payloads are redacted
// or omitted.
//
// Logging never changes program behavior: terminal writes pass through
// untouched, and a file failure is reported once on the real stderr before
// logging switches itself off instead of throwing or recursing.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_DIR = fileURLToPath(new URL('../logs', import.meta.url));

const MAX_LINE = 20_000;
const MAX_PENDING = 16_384;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTHORIZATION = /(\b(?:Proxy-)?Authorization\b)(["']?\s*:\s*)[^\n,;]+/gi;
const MEDIA_DATA = /\bdata:[^,\s]+;base64,[A-Za-z0-9+/=]+/gi;
const BASE64_BLOB = /[A-Za-z0-9+/]{512,}={0,2}/g;
const BINARY_DUMP = /(?:<Buffer(?: [0-9a-f]{2}){4,}|(?:Uint8|Uint8Clamped|Int8|Uint16|Int16|Float32|Float64)Array\(\d+\)\s*\[[^\]]*\])/i;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PROVIDER_KEY = /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g;
const URL_USERINFO = /\b(wss?:\/\/)[^/\s@]+@/gi;
const URL_SECRET = /([?&](?:access_token|refresh_token|id_token|api_key|apikey|api_secret|client_secret|token|secret|password|key|sig|signature)=)[^&\s"'<>]+/gi;
const PROP = String.raw`(?:(?:[A-Za-z0-9$]+[._-])?(?:api[_-]?key|apikey|api[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token)|[A-Za-z0-9$]+(?:ApiKey|APIKey|ApiSecret|AccessToken|RefreshToken|AuthToken|ClientSecret|PrivateKey|Password|Secret|Token))`;
const QUOTED_SECRET = new RegExp(String.raw`(["']?)(${PROP})\1(\s*[:=]\s*)(["'])((?:\\.|(?!\4)[^\\\n])*)\4`, 'gi');
const BARE_SECRET = new RegExp(String.raw`(${PROP})(\s*[:=]\s*)([^\s,;&"'()[\]{}]+)`, 'gi');
const SECRET_ENV = /(?:^|_)(?:api_?key|key|secret|token|password|passwd|passphrase|credential|auth)(?:_|$)/i;
const PLACEHOLDER = /^(?:YOUR_|CHANGE_?ME|<.*>|x{6,}|\.{3,}|example|placeholder)/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });

let session = null;

/** Entry file name without its extension, e.g. "agent" for agent/agent.mjs. */
export function detectRole(argv = process.argv) {
  const entry = argv[1];
  if (!entry) return 'node';
  return safeRole(basename(entry).replace(/\.(?:mjs|cjs|js)$/i, ''));
}

function safeRole(role) {
  return String(role || 'node').replaceAll(/[^A-Za-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40) || 'node';
}

function collectSecrets(env) {
  const found = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !SECRET_ENV.test(name)) continue;
    const secret = value.trim();
    if (secret.length < 8 || PLACEHOLDER.test(secret) || found.has(secret)) continue;
    found.set(secret, name);
  }
  return [...found]
    .map(([value, name]) => [value, `[redacted:${name}]`])
    .sort((a, b) => b[0].length - a[0].length);
}

function createLogFile(role) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const base = `${stamp}__${role}__${process.pid}-${randomBytes(3).toString('hex')}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const file = join(LOG_DIR, attempt ? `${base}-${attempt}.log` : `${base}.log`);
    try {
      return { file, fd: openSync(file, 'wx', 0o600) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('no unused log file name');
}

function toText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (ArrayBuffer.isView(chunk)) {
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (view.includes(0)) return `[binary output omitted: ${view.length} bytes]`;
    try {
      return utf8.decode(view);
    } catch {
      return `[binary output omitted: ${view.length} bytes]`;
    }
  }
  return String(chunk);
}

function clean(text, secrets) {
  let out = text.replaceAll(ANSI, '');
  if (out.length > MAX_LINE) {
    const cut = out.slice(0, MAX_LINE);
    const boundary = cut.search(/\S*$/);
    const kept = boundary > 0 ? cut.slice(0, boundary) : '';
    out = `${kept} … [truncated ${text.length - kept.length} chars]`;
  }
  out = out.replaceAll(MEDIA_DATA, '[media payload omitted]');
  out = out.replaceAll(BASE64_BLOB, '[base64 omitted]');
  if (BINARY_DUMP.test(out)) out = `[binary/media output omitted: ${out.length} chars]`;
  for (const [value, marker] of secrets) if (out.includes(value)) out = out.split(value).join(marker);
  out = out.replaceAll(BEARER, 'Bearer [redacted]');
  out = out.replaceAll(AUTHORIZATION, '$1$2[redacted]');
  out = out.replaceAll(URL_USERINFO, '$1[redacted]@');
  out = out.replaceAll(URL_SECRET, '$1[redacted]');
  out = out.replaceAll(QUOTED_SECRET, '$1$2$1$3$4[redacted]$4');
  out = out.replaceAll(BARE_SECRET, '$1$2[redacted]');
  out = out.replaceAll(JWT, '[redacted:jwt]');
  out = out.replaceAll(PROVIDER_KEY, '[redacted:key]');
  return out;
}

/**
 * Starts per-run logging once. Returns the active session; importing this
 * module starts it automatically, so entrypoints only need the side-effect
 * import. Repeat calls return the same session.
 * @param {{ role?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function initializeLogging({ role = detectRole(), env = process.env } = {}) {
  if (session) return session;

  const startedAt = Date.now();
  const name = safeRole(role);
  const secrets = collectSecrets(env);
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const rawOut = originalOut.bind(process.stdout);
  const rawErr = originalErr.bind(process.stderr);
  const buffers = { out: '', err: '' };
  let fd = null;
  let file = null;
  let active = false;
  let finished = false;
  let patchedOut = originalOut;
  let patchedErr = originalErr;

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    ({ file, fd } = createLogFile(name));
  } catch (error) {
    const message = error?.message || String(error);
    try {
      rawErr(`[log] could not create a log file in ${LOG_DIR}: ${message}\n`);
    } catch { /* stderr is gone too */ }
    session = { enabled: false, path: null, role: name, startedAt, error: message, stop() {} };
    return session;
  }

  active = true;
  session = {
    enabled: true,
    path: file,
    role: name,
    startedAt,
    error: null,
    stop: () => finish('logging stopped'),
  };

  function restore() {
    if (process.stdout.write === patchedOut) process.stdout.write = originalOut;
    if (process.stderr.write === patchedErr) process.stderr.write = originalErr;
  }

  function fail(error) {
    if (!active) return;
    active = false;
    const message = error?.message || String(error);
    const doomed = fd;
    fd = null;
    try {
      if (doomed !== null) closeSync(doomed);
    } catch { /* already closed */ }
    restore();
    session.enabled = false;
    session.error = message;
    try {
      rawErr(`[log] stopped writing ${file}: ${message}\n`);
    } catch { /* stderr is gone too */ }
  }

  function record(label, text) {
    if (!active || fd === null) return;
    try {
      writeSync(fd, `${new Date().toISOString()} ${label} | ${clean(String(text), secrets)}\n`);
    } catch (error) {
      fail(error);
    }
  }

  function capture(label, chunk) {
    if (!active || fd === null) return;
    const text = toText(chunk);
    if (!text) return;
    let pending = buffers[label] + text;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      record(label, line);
      if (!active) {
        buffers[label] = '';
        return;
      }
      index = pending.indexOf('\n');
    }
    if (pending.length > MAX_PENDING) {
      record(label, pending);
      pending = '';
    }
    buffers[label] = pending;
  }

  function patched(label, original) {
    return function write(...args) {
      if (active) {
        try {
          capture(label, args[0]);
        } catch (error) {
          fail(error);
        }
      }
      return Reflect.apply(original, this, args);
    };
  }

  function flush(label) {
    const pending = buffers[label];
    if (!pending) return;
    buffers[label] = '';
    record(label, pending);
  }

  function finish(note, keepOpen = false) {
    if (finished) return;
    finished = true;
    if (!active) return;
    flush('out');
    flush('err');
    record('log', `=== ${note} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s ===`);
    if (keepOpen) return; // process exit: later exit listeners may still write
    active = false;
    const doomed = fd;
    fd = null;
    try {
      if (doomed !== null) closeSync(doomed);
    } catch { /* process exit will close it */ }
    restore();
    session.enabled = false;
  }

  try {
    patchedOut = patched('out', originalOut);
    patchedErr = patched('err', originalErr);
    process.stdout.write = patchedOut;
    process.stderr.write = patchedErr;
  } catch (error) {
    fail(error);
    return session;
  }

  record('log', '=== chertbusters run log ===');
  record('log', `role: ${name}`);
  record('log', `pid: ${process.pid} (parent ${process.ppid})`);
  record('log', `started: ${new Date(startedAt).toISOString()}`);
  record('log', `cwd: ${process.cwd()}`);
  record('log', `node: ${process.version} ${process.platform}/${process.arch}`);
  record('log', `argv: ${JSON.stringify(process.argv)}`);
  record('log', `redaction: ${secrets.length} env value(s), bearer/authorization tokens, credential-shaped keys`);
  try {
    rawOut(`[log] ${file}\n`);
  } catch { /* the terminal is gone; the file still records this run */ }

  process.on('exit', code => finish(`exit code ${code}`, true));
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    if (!active) return;
    flush('out');
    flush('err');
    record('log', `=== uncaught ${origin}: ${error?.message || error} ===`);
    for (const line of String(error?.stack || error || 'unknown error').split('\n')) record('err', line);
  });

  return session;
}

export default initializeLogging();
