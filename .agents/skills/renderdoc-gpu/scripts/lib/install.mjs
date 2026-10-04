// `install`: set up the rdc-cli backend end to end (uv -> rdc-cli -> RenderDoc Python module build
// -> rdc doctor -> config), plus the Nsight Perf SDK plugin. Idempotent: finished steps are skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IS_WIN, configPath, nvPluginFiles } from './env.mjs';
import { findRdc } from './rdc.mjs';
import { setupNvPerf } from './setup.mjs';

const which = (cmd) => {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) : null;
};

function findUv() {
  const home = os.homedir();
  return which('uv') || [path.join(home, '.local', 'bin', IS_WIN ? 'uv.exe' : 'uv'), path.join(home, '.cargo', 'bin', IS_WIN ? 'uv.exe' : 'uv')].find((p) => fs.existsSync(p)) || null;
}

function vsBuildTools() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function latestRenderDocTag() {
  const r = spawnSync('git', ['ls-remote', '--tags', 'https://github.com/baldurk/renderdoc.git'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) return null;
  const tags = [...r.stdout.matchAll(/refs\/tags\/(v1\.(\d+))$/gm)].map((m) => ({ tag: m[1], n: Number(m[2]) }));
  tags.sort((a, b) => b.n - a.n);
  return tags[0]?.tag || null;
}

function rdcDoctor(rdc) {
  const r = spawnSync(rdc, ['doctor'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = text.match(/renderdoc-module: version=([\d.]+)/);
  return { ok: /\[ok\] renderdoc-module/.test(text) && /\[ok\] replay-support/.test(text), version: m ? m[1] : null, text };
}

function run(cmd, args, opts = {}) {
  process.stderr.write(`$ ${cmd} ${args.join(' ')}\n`);
  return spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

export function install(opts = {}) {
  const log = [];
  const step = (status, msg) => { log.push(`[${status}] ${msg}`); process.stderr.write(`[${status}] ${msg}\n`); };
  const fail = (msg) => { step('NEED USER', msg); return { ok: false, text: log.join('\n') }; };

  // 1. basics
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) return fail(`Node ${process.versions.node} is too old; install Node.js 18+ (https://nodejs.org)`);
  step('ok', `node ${process.versions.node}`);
  if (!which('git')) return fail(IS_WIN ? 'git is missing: `winget install --id Git.Git -e` (then reopen the terminal)' : 'git is missing: install it with your package manager');
  step('ok', 'git');

  // 2. C++ toolchain for building RenderDoc's Python module
  if (IS_WIN) {
    const vs = vsBuildTools();
    if (!vs) {
      return fail('Visual Studio Build Tools with the C++ workload are required to build the RenderDoc Python module. Ask the user to run (admin/UAC prompt):\n'
        + '  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"\n'
        + 'or install "Desktop development with C++" from https://visualstudio.microsoft.com/downloads/ , then rerun `install`.');
    }
    step('ok', `Visual Studio C++ tools: ${vs}`);
  } else {
    const missing = ['cmake', 'ninja', 'g++', 'bison', 'autoconf', 'automake', 'libtoolize', 'pkg-config'].filter((t) => !which(t));
    if (missing.length) return fail(`missing build tools: ${missing.join(', ')} (Debian/Ubuntu: sudo apt install cmake ninja-build g++ bison autoconf automake libtool pkg-config python3-dev libx11-dev libx11-xcb-dev libxcb-keysyms1-dev libgl-dev)`);
    step('ok', 'build tools');
  }

  // 3. uv (Python tool installer used by rdc-cli)
  let uv = findUv();
  if (!uv && !opts.check) {
    step('do', 'installing uv');
    const r = IS_WIN
      ? run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'])
      : run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
    if (r.status !== 0) return fail('uv install failed — see https://docs.astral.sh/uv/getting-started/installation/');
    uv = findUv();
  }
  if (!uv) return fail('uv not found (run without --check to install it)');
  step('ok', `uv: ${uv}`);

  // 4. rdc-cli
  let rdc = findRdc();
  if (!rdc && !opts.check) {
    step('do', 'installing rdc-cli (uv tool install)');
    const r = run(uv, ['tool', 'install', opts.rdcSource || 'rdc-cli']);
    if (r.status !== 0) return fail('`uv tool install rdc-cli` failed (see output above)');
    rdc = findRdc();
  }
  if (!rdc) return fail('rdc not found after install; make sure ~/.local/bin is on PATH (`uv tool update-shell`) and rerun');
  step('ok', `rdc-cli: ${rdc}`);

  // 5. RenderDoc Python module, built by rdc for its own Python
  const want = opts.renderdocVersion || latestRenderDocTag() || 'v1.46';
  let doc = rdcDoctor(rdc);
  const have = doc.version ? `v${doc.version}` : null;
  if (doc.ok && (!opts.renderdocVersion || have === want)) {
    step('ok', `RenderDoc module ${have} already built (rdc doctor ok)`);
  } else if (opts.check || opts.skipBuild) {
    return fail(`RenderDoc Python module not built${have ? ` (have ${have}, want ${want})` : ''}: run \`install\` without --check/--skip-build`);
  } else {
    step('do', `building RenderDoc ${want} Python module with rdc setup-renderdoc — takes 10–40 min (clone + compile); run with a long timeout or in the background`);
    const r = run(rdc, ['setup-renderdoc', '--version', want]);
    if (r.status !== 0) return fail('`rdc setup-renderdoc` failed (see output above). Typical causes: no C++ toolchain, no network to github.com, antivirus locking files. Rerun after fixing.');
    doc = rdcDoctor(rdc);
    if (!doc.ok) return fail(`rdc doctor still fails after the build:\n${doc.text}`);
    step('ok', `RenderDoc module v${doc.version} built`);
  }

  // 6. remember the backend
  const cfgFile = configPath();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* new */ }
  cfg.host = 'rdc';
  cfg.rdc = rdc;
  if (!opts.check) {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    step('ok', `config written: ${cfgFile} (host = rdc)`);
  }

  // 7. NVIDIA counters
  const nvidia = which('nvidia-smi') || (IS_WIN && fs.existsSync('C:\\Windows\\System32\\nvidia-smi.exe'));
  if (nvPluginFiles().length) step('ok', 'Nsight Perf SDK library installed');
  else if (nvidia) {
    const r = opts.check ? { ok: false, text: '' } : setupNvPerf({});
    if (r.ok) step('ok', 'Nsight Perf SDK library installed from a local download');
    else step('NEED USER', 'NVIDIA GPU detected but the Nsight Perf SDK is not installed (hardware counters disabled). '
      + 'Ask the user to download it from https://developer.nvidia.com/nsight-perf-sdk/get-started (NVIDIA login), then run `setup-nvperf --from <file>`.');
  } else step('ok', 'no NVIDIA GPU detected: Nsight Perf SDK not needed');

  step('ok', 'ready — next: `doctor --capture <file.rdc>`');
  return { ok: true, text: log.join('\n') };
}
