// Locating RenderDoc, its Python host and the Nsight Perf SDK plugin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRdc } from './rdc.mjs';

export const IS_WIN = process.platform === 'win32';

// Optional user config: { "renderdoc": "<qrenderdoc dir or exe>", "pythonPath": "<renderdoc module dir>",
//   "python": "<interpreter>", "cases": "<cache dir>", "env": { "VAR": "value" } }
export function configPath() {
  if (process.env.RDGPU_CONFIG) return process.env.RDGPU_CONFIG;
  const base = IS_WIN ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')) : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'rdgpu', 'config.json');
}
let _cfg;
export function config() {
  if (_cfg === undefined) {
    try { _cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { _cfg = {}; }
    for (const [k, v] of Object.entries(_cfg.env || {})) if (process.env[k] === undefined) process.env[k] = String(v);
    if (_cfg.renderdoc && !process.env.RDGPU_RENDERDOC) process.env.RDGPU_RENDERDOC = _cfg.renderdoc;
    if (_cfg.pythonPath && !process.env.RENDERDOC_PYTHON_PATH) process.env.RENDERDOC_PYTHON_PATH = _cfg.pythonPath;
    if (_cfg.python && !process.env.RDGPU_PYTHON) process.env.RDGPU_PYTHON = _cfg.python;
    if (_cfg.cases && !process.env.RDGPU_CASES) process.env.RDGPU_CASES = _cfg.cases;
  }
  return _cfg;
}

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// RenderDoc loads nvperf_grfx_host from FileIO::GetAppFolderFilename("plugins/nv"):
//   Windows: %APPDATA%\renderdoc\plugins\nv     Linux: ~/.renderdoc/plugins/nv
export function nvPluginDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'renderdoc', 'plugins', 'nv');
  return path.join(os.homedir(), '.renderdoc', 'plugins', 'nv');
}

export function nvPluginFiles() {
  const dir = nvPluginDir();
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^(lib)?nvperf_grfx_host/i.test(f)).map((f) => path.join(dir, f));
}

export function renderdocLogDir() {
  return IS_WIN ? path.join(os.tmpdir(), 'RenderDoc') : '/tmp/RenderDoc';
}

function regQuery(key, value) {
  const args = ['query', key];
  if (value === null) args.push('/ve'); else if (value) args.push('/v', value);
  const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

function which(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
}

// Returns candidate qrenderdoc executables, best first.
export function findQRenderDoc() {
  const out = [];
  const add = (p, how) => {
    if (!p) return;
    let exe = p;
    try { if (fs.statSync(p).isDirectory()) exe = path.join(p, IS_WIN ? 'qrenderdoc.exe' : 'qrenderdoc'); } catch { return; }
    if (!exists(exe) && !IS_WIN && exists(path.join(p, 'bin', 'qrenderdoc'))) exe = path.join(p, 'bin', 'qrenderdoc');
    if (exists(exe) && !out.some((x) => x.exe === exe)) out.push({ exe, how });
  };
  add(process.env.RDGPU_RENDERDOC, 'RDGPU_RENDERDOC');
  add(process.env.RENDERDOC_DIR, 'RENDERDOC_DIR');
  if (IS_WIN) {
    for (const key of ['HKLM\\SOFTWARE\\Classes\\RenderDoc.RDCCapture.1\\shell\\open\\command',
      'HKCU\\SOFTWARE\\Classes\\RenderDoc.RDCCapture.1\\shell\\open\\command']) {
      const m = regQuery(key, null).match(/"([^"]*qrenderdoc\.exe)"/i);
      if (m) add(m[1], 'registry (.rdc file association)');
    }
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) add(path.join(base, 'RenderDoc'), 'default install dir');
    }
  } else {
    for (const p of ['/usr/bin/qrenderdoc', '/usr/local/bin/qrenderdoc', '/opt/renderdoc/bin/qrenderdoc']) add(p, 'system');
    try {
      for (const d of fs.readdirSync('/opt')) if (/renderdoc/i.test(d)) add(path.join('/opt', d, 'bin', 'qrenderdoc'), '/opt');
    } catch { /* ignore */ }
  }
  add(which(IS_WIN ? 'qrenderdoc.exe' : 'qrenderdoc'), 'PATH');
  return out;
}

// Standalone-python host: RDGPU_PYTHON (interpreter) + RENDERDOC_PYTHON_PATH (dir with renderdoc module).
export function findPythonHost() {
  const mod = process.env.RENDERDOC_PYTHON_PATH;
  if (!mod) return null;
  const py = process.env.RDGPU_PYTHON || (IS_WIN ? 'python' : 'python3');
  return { python: py, modulePath: mod };
}

export function chooseHost(opts = {}) {
  const prefer = opts.host || process.env.RDGPU_HOST || config().host;
  if (prefer === 'rdc' || !prefer) {
    const exe = findRdc();
    if (exe) return { kind: 'rdc', exe };
    if (prefer === 'rdc') throw new Error('host rdc requested but rdc-cli is not installed — run `install`');
  }
  const py = findPythonHost();
  const qs = findQRenderDoc();
  if (prefer === 'python') {
    if (!py) throw new Error('RDGPU_HOST=python but RENDERDOC_PYTHON_PATH is not set');
    return { kind: 'python', ...py };
  }
  if (prefer !== 'qrenderdoc' && py) return { kind: 'python', ...py };
  if (qs.length) return { kind: 'qrenderdoc', exe: qs[0].exe, how: qs[0].how };
  if (py) return { kind: 'python', ...py };
  throw new Error('No RenderDoc backend found. Run `install` (sets up rdc-cli + RenderDoc Python module), or install RenderDoc from '
    + 'https://renderdoc.org/builds for the fallback qrenderdoc host. Run `doctor` for details.');
}

export function nodeOk() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 18;
}
