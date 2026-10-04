// rdc-cli backend: one rdc daemon per capture (named session), our jobs run inside it via the
// daemon's "script" RPC, so the capture is loaded once and stays open for the agent's live work.
// https://github.com/BANANASJIM/rdc-cli
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IS_WIN, config } from './env.mjs';

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

export function findRdc() {
  const cfg = config();
  const cands = [process.env.RDGPU_RDC, cfg.rdc];
  const w = spawnSync(IS_WIN ? 'where' : 'which', ['rdc'], { encoding: 'utf8', windowsHide: true });
  if (w.status === 0) cands.push(...w.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  const home = os.homedir();
  cands.push(path.join(home, '.local', 'bin', IS_WIN ? 'rdc.exe' : 'rdc'));
  if (IS_WIN && process.env.USERPROFILE) cands.push(path.join(process.env.USERPROFILE, '.local', 'bin', 'rdc.exe'));
  return cands.find(exists) || null;
}

export function rdcDataDir() {
  if (process.env.RDC_DATA_DIR) return process.env.RDC_DATA_DIR;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || os.homedir(), 'rdc');
  return path.join(os.homedir(), '.rdc');
}

export function sessionName(capture) {
  const abs = path.resolve(capture);
  return 'rdgpu-' + crypto.createHash('sha1').update(IS_WIN ? abs.toLowerCase() : abs).digest('hex').slice(0, 10);
}

function readSession(name) {
  try { return JSON.parse(fs.readFileSync(path.join(rdcDataDir(), 'sessions', `${name}.json`), 'utf8')); } catch { return null; }
}

// One JSON-RPC request over the daemon's TCP socket (newline-delimited JSON).
export function rpc(sess, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: sess.host, port: sess.port });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rdc daemon did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _token: sess.token } }) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(timer);
        sock.end();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function liveSession(capture) {
  const name = sessionName(capture);
  const sess = readSession(name);
  if (!sess) return null;
  if (path.resolve(sess.capture) !== path.resolve(capture)) return null;
  try {
    const r = await rpc(sess, 'ping', {}, 3000);
    return r && !r.error ? { ...sess, name } : null;
  } catch { return null; }
}

// Start (or reuse) the rdc daemon for this capture. Returns the session record.
export async function ensureDaemon(capture, opts = {}) {
  const live = await liveSession(capture);
  if (live) return live;
  const exe = opts.rdc || findRdc();
  if (!exe) throw new Error('rdc-cli not found. Run `install` (see references/setup.md).');
  const name = sessionName(capture);
  if (!opts.quiet) process.stderr.write(`[renderdoc-gpu] starting rdc session ${name} for ${path.basename(capture)} (loads the capture once)…\n`);
  const args = ['--session', name, 'open', path.resolve(capture), '--timeout', String(opts.openTimeout || 600)];
  if (opts.gpu) args.push('--gpu', opts.gpu);
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: (opts.openTimeout || 600) * 1000 + 30000 });
  if (r.status !== 0) {
    const msg = `${r.stdout || ''}${r.stderr || ''}`.trim() || String(r.error || 'unknown error');
    throw new Error(`rdc could not open the capture:\n${msg}\nCheck \`rdc doctor\` and \`doctor --capture <rdc>\`.`);
  }
  const sess = await liveSession(capture);
  if (!sess) throw new Error('rdc open reported success but the session is not reachable.');
  return sess;
}

export function closeDaemon(capture, opts = {}) {
  const exe = opts.rdc || findRdc();
  if (!exe) return false;
  const r = spawnSync(exe, ['--session', sessionName(capture), 'close'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

// Run rdjob.py inside the daemon with the job file as argument; progress is tailed by the caller.
export async function runScript(sess, rdjob, jobFile, timeoutMs) {
  const r = await rpc(sess, 'script', { path: rdjob, args: { job: jobFile } }, timeoutMs);
  if (r.error) throw new Error(`rdc script failed: ${r.error.message || JSON.stringify(r.error)}`);
  return r.result;
}
