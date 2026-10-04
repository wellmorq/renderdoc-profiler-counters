// doctor + setup-nvperf.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chooseHost, findPythonHost, findQRenderDoc, IS_WIN, nodeOk, nvPluginDir, nvPluginFiles } from './env.mjs';
import { runJob } from './runner.mjs';

export const NVPERF_URL = 'https://developer.nvidia.com/nsight-perf-sdk/get-started';
const DLL_RE = IS_WIN ? /(^|[\\/])nvperf_grfx_host\.dll$/i : /(^|[\\/])libnvperf_grfx_host\.so(\.[\d.]+)?$/i;

// Minimal zip reader (central directory + deflate/store). Enough for the SDK archive.
function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff) { // zip64
      const loc = eocd - 20;
      const z64off = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = Buffer.alloc(56);
      fs.readSync(fd, z64, 0, 56, z64off);
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOff = Number(z64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const entries = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      let lho = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nlen).toString('utf8');
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = cd.readUInt16LE(x); const sz = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); }
        }
        x += 4 + sz;
      }
      entries.push({ name, method, csize, usize, lho });
      p = xend + clen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function extractZipEntry(file, e, dest) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, e.lho);
    const start = e.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const data = Buffer.alloc(e.csize);
    fs.readSync(fd, data, 0, e.csize, start);
    const out = e.method === 0 ? data : zlib.inflateRawSync(data);
    fs.writeFileSync(dest, out);
  } finally {
    fs.closeSync(fd);
  }
}

function rankDllPath(p) {
  const s = p.replace(/\\/g, '/').toLowerCase();
  let score = 0;
  if (/nvperf\/bin\/x64|\/bin\/x64\//.test(s)) score += 10;
  if (/\/bin\//.test(s)) score += 3;
  if (/samples?\//.test(s)) score -= 5;
  if (/x86\/|win32/.test(s)) score -= 20;
  return score - s.length / 1000;
}

function walk(dir, depth, out) {
  if (depth < 0) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out);
    else out.push(p);
  }
  return out;
}

function candidateSources() {
  const home = os.homedir();
  const dirs = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), process.cwd(), home];
  if (IS_WIN) dirs.push('C:\\NVIDIA', 'C:\\Program Files\\NVIDIA Corporation');
  const out = [];
  for (const d of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (/nsight[_ -]?perf[_ -]?sdk|^nvperf/i.test(e.name)) out.push(path.join(d, e.name));
    }
  }
  return out;
}

export function setupNvPerf(opts = {}) {
  const log = [];
  const sources = opts.from ? [path.resolve(opts.from)] : candidateSources();
  const destDir = nvPluginDir();
  const found = [];
  for (const src of sources) {
    if (!fs.existsSync(src)) { log.push(`not found: ${src}`); continue; }
    const st = fs.statSync(src);
    if (st.isFile() && /\.zip$/i.test(src)) {
      try {
        const ents = listZip(src).filter((e) => DLL_RE.test(e.name));
        if (!ents.length) { log.push(`${src}: zip has no ${IS_WIN ? 'nvperf_grfx_host.dll' : 'libnvperf_grfx_host.so'}`); continue; }
        found.push({ kind: 'zip', src, entries: ents });
      } catch (e) { log.push(`${src}: ${e.message}`); }
    } else if (st.isFile() && DLL_RE.test(src)) {
      found.push({ kind: 'file', src, files: [src] });
    } else if (st.isDirectory()) {
      const files = walk(src, 8, []).filter((f) => DLL_RE.test(f));
      if (files.length) found.push({ kind: 'dir', src, files });
      else log.push(`${src}: no ${IS_WIN ? 'nvperf_grfx_host.dll' : 'libnvperf_grfx_host.so*'} inside`);
    } else if (st.isFile() && /\.(exe|msi|run)$/i.test(src)) {
      log.push(`${src}: installer, not an archive — run it (or extract it) first, then pass the install folder with --from`);
    }
  }
  if (!found.length) {
    return {
      ok: false,
      text: [
        'Nsight Perf SDK not found locally.' + (log.length ? '\n' + log.map((l) => '  ' + l).join('\n') : ''),
        '',
        'ASK THE USER to do this (needs an NVIDIA developer login, an agent cannot do it):',
        `  1. Open ${NVPERF_URL} , sign in, accept the license, download the ${IS_WIN ? 'Windows' : 'Linux'} package`,
        `     (e.g. NVIDIA_Nsight_Perf_SDK_<version>_${IS_WIN ? 'Windows.zip' : 'Linux.tar.gz/zip'}). Prefer the newest version:`,
        '     RenderDoc rejects SDK builds older than the one it was compiled against ("not supported").',
        '  2. Tell the agent where the file is, then run:',
        '     setup-nvperf --from <path to the .zip, the extracted folder, or the DLL itself>',
        `It copies ${IS_WIN ? 'nvperf_grfx_host.dll' : 'libnvperf_grfx_host.so*'} to ${destDir} (where RenderDoc looks for it).`,
      ].join('\n'),
    };
  }
  fs.mkdirSync(destDir, { recursive: true });
  const pick = found[0];
  const copied = [];
  if (pick.kind === 'zip') {
    const ents = [...pick.entries].sort((a, b) => rankDllPath(b.name) - rankDllPath(a.name));
    const chosen = IS_WIN ? [ents[0]] : ents.filter((e) => path.dirname(e.name) === path.dirname(ents[0].name));
    for (const e of chosen) {
      const dest = path.join(destDir, path.basename(e.name));
      extractZipEntry(pick.src, e, dest);
      copied.push(`${pick.src}!${e.name} -> ${dest}`);
    }
  } else {
    const files = [...pick.files].sort((a, b) => rankDllPath(b) - rankDllPath(a));
    const chosen = IS_WIN ? [files[0]] : files.filter((f) => path.dirname(f) === path.dirname(files[0]));
    for (const f of chosen) {
      const dest = path.join(destDir, path.basename(f));
      fs.copyFileSync(f, dest);
      copied.push(`${f} -> ${dest}`);
    }
  }
  return {
    ok: true,
    text: ['Installed Nsight Perf SDK host library for RenderDoc:', ...copied.map((c) => '  ' + c),
      'Verify with: doctor --capture <some .rdc>  (NVIDIA counters must be listed, no "ERROR: ... Nsight Perf SDK" entry).',
      'Already-prepared cases need `fetch <capture> nv-pack` (or `open <capture> --force`) to pick up NVIDIA counters.'].join('\n'),
  };
}

export async function doctor(opts = {}) {
  const lines = [];
  let ready = true;
  lines.push(`node ${process.versions.node} ${nodeOk() ? 'OK' : 'TOO OLD (need 18+)'} | ${process.platform} ${os.release()}`);
  const qs = findQRenderDoc();
  const py = findPythonHost();
  if (qs.length) qs.forEach((q, i) => lines.push(`${i ? '   ' : ''}qrenderdoc: ${q.exe}  [${q.how}]`));
  else lines.push('qrenderdoc: NOT FOUND (install RenderDoc from https://renderdoc.org/builds or set RDGPU_RENDERDOC=<install dir>)');
  if (py) lines.push(`python host: ${py.python} + renderdoc module at ${py.modulePath} (RENDERDOC_PYTHON_PATH)`);
  let host = null;
  try { host = chooseHost(opts); } catch (e) { lines.push(`host: ${e.message}`); ready = false; }
  if (host) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdgpu-doctor-'));
    try {
      const tasks = opts.capture ? [{ type: 'info', required: true }] : ['version'];
      const job = opts.capture ? { capture: path.resolve(opts.capture), tasks } : { capture: '', tasks };
      const res = await runJob(tmp, job, { hostInfo: host, timeoutSec: opts.timeout || 180, quiet: !opts.verbose });
      lines.push(`host ${host.kind} works: RenderDoc ${res.renderdocVersion}${host.kind === 'qrenderdoc' ? ' (embedded python, headless --python mode)' : ''}`);
      if (opts.capture) {
        if (!res.ok) { lines.push(`capture check FAILED: ${res.error || res.tasks?.[0]?.error}`); ready = false; } else {
          const info = JSON.parse(fs.readFileSync(path.join(tmp, 'info.json'), 'utf8'));
          const fam = {};
          for (const c of info.counters) fam[c.family] = (fam[c.family] || 0) + 1;
          lines.push(`capture: ${info.api}, replay vendor ${info.vendor}${info.degraded ? ' (DEGRADED)' : ''}; counters: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
          for (const e of info.counterErrors || []) { lines.push(`  counter backend: ${e}`); ready = false; }
          if (/nvidia/i.test(info.vendor) && !fam.nvidia) { lines.push('  NVIDIA GPU but no NVIDIA counters — check Nsight Perf SDK install / GPU support'); ready = false; }
        }
      }
    } catch (e) {
      lines.push(`host ${host.kind} FAILED: ${e.message.split('\n').slice(0, 12).join('\n  ')}`);
      if (host.kind === 'qrenderdoc') lines.push('  If a RenderDoc window/dialog appeared (first-run analytics prompt, update notice), answer it once in the UI and rerun doctor.');
      ready = false;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const nv = nvPluginFiles();
  lines.push(`Nsight Perf SDK plugin dir: ${nvPluginDir()}`);
  if (nv.length) {
    for (const f of nv) {
      const st = fs.statSync(f);
      lines.push(`  ${path.basename(f)}  ${(st.size / 1048576).toFixed(1)} MB  ${st.mtime.toISOString().slice(0, 10)}`);
    }
  } else {
    lines.push('  MISSING — NVIDIA hardware counters disabled. Fix: setup-nvperf (it explains what the user must download).');
    if (!opts.capture) lines.push('  (only matters on NVIDIA GPUs)');
  }
  lines.push(ready ? 'STATUS: ready' : 'STATUS: action needed (see above)');
  return { ready, text: lines.join('\n') };
}
