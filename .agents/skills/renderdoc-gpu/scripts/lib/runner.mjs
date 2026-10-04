// Runs rdjob.py inside RenderDoc and streams its progress log to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chooseHost, IS_WIN, renderdocLogDir } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RDJOB = path.join(HERE, '..', 'rdjob.py');

function latestRenderDocLog() {
  const dir = renderdocLogDir();
  try {
    const logs = fs.readdirSync(dir).filter((f) => f.endsWith('.log'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!logs.length) return null;
    const text = fs.readFileSync(logs[0].f, 'utf8').split(/\r?\n/);
    const interesting = text.filter((l) => /Error|Fatal|Crash|Warning/.test(l)).slice(-12);
    return { file: logs[0].f, lines: interesting.length ? interesting : text.slice(-12) };
  } catch {
    return null;
  }
}

/**
 * job: { capture, tasks: [...] } — out/progress/result are filled in here.
 * Returns the parsed result.json; throws with a diagnostic message when RenderDoc died.
 */
export async function runJob(jobDir, job, opts = {}) {
  fs.mkdirSync(jobDir, { recursive: true });
  const out = opts.out || jobDir;
  const full = {
    ...job,
    out,
    progress: path.join(jobDir, 'progress.log'),
    result: path.join(jobDir, 'result.json'),
  };
  for (const f of [full.progress, full.result]) fs.rmSync(f, { force: true });
  const jobFile = path.join(jobDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(full, null, 1));

  if (opts.sessionDir && !opts.noSession) {
    const alive = sessionAlive(opts.sessionDir, job.capture);
    if (alive) return runInSession(opts.sessionDir, jobFile, full, opts);
  }
  return spawnJob(jobFile, full, job, opts);
}

// A session is alive when its heartbeat is fresh and it serves the same capture.
export function sessionAlive(sdir, capture) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(sdir, 'alive.json'), 'utf8'));
    const pidOk = () => { try { process.kill(a.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    if (Date.now() / 1000 - a.t > 5 && !(a.busy && pidOk())) return null;
    if (capture && path.resolve(a.capture) !== path.resolve(capture)) return null;
    return a;
  } catch { return null; }
}

async function runInSession(sdir, jobFile, full, opts) {
  const inbox = path.join(sdir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const name = `${Date.now()}-${process.pid}.json`;
  fs.writeFileSync(path.join(inbox, name + '.tmp'), fs.readFileSync(jobFile));
  fs.renameSync(path.join(inbox, name + '.tmp'), path.join(inbox, name));
  if (!opts.quiet) process.stderr.write(`[renderdoc-gpu] running ${full.tasks.map((t) => t.type || t).join(', ')} in the open session\n`);
  const deadline = Date.now() + (opts.timeoutSec || 1800) * 1000;
  let offset = 0;
  for (;;) {
    if (!opts.quiet) {
      try {
        const st = fs.statSync(full.progress);
        if (st.size > offset) {
          const fd = fs.openSync(full.progress, 'r');
          const buf = Buffer.alloc(st.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); offset = st.size;
          for (const l of buf.toString('utf8').split('\n').filter(Boolean)) if (opts.verbose || !/loading capture|\] state \d+\/|done in |fetching counters \d+-/.test(l)) process.stderr.write(`  rd| ${l}\n`);
        }
      } catch { /* not yet */ }
    }
    if (fs.existsSync(full.result)) {
      try { return JSON.parse(fs.readFileSync(full.result, 'utf8')); } catch { /* being written */ }
    }
    if (Date.now() > deadline) throw new Error(`session job timed out (${jobFile})`);
    if (!sessionAlive(sdir) && !fs.existsSync(full.result)) {
      if (fs.existsSync(path.join(inbox, name))) {
        fs.rmSync(path.join(inbox, name), { force: true });
        return spawnJob(jobFile, full, full, { ...opts, noSession: true });
      }
      throw new Error('the RenderDoc session died while running the job (replay crash?). Run the command again without a session; see the RenderDoc log.');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Start a session in the background: RenderDoc keeps the capture loaded until idle/stop.
export function startSession(sdir, capture, opts = {}) {
  fs.mkdirSync(sdir, { recursive: true });
  for (const f of ['stop', 'alive.json']) fs.rmSync(path.join(sdir, f), { force: true });
  const job = { capture, tasks: [], serve: { dir: sdir, idle: opts.idle || 900 }, out: sdir, progress: path.join(sdir, 'session.log'), result: path.join(sdir, 'session-result.json') };
  const jobFile = path.join(sdir, 'session-job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 1));
  const host = opts.hostInfo || chooseHost(opts);
  const { cmd, args, env } = hostCommand(host, jobFile);
  const child = spawn(cmd, args, { env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid, jobFile };
}

export function stopSession(sdir) {
  if (!sessionAlive(sdir)) return false;
  fs.writeFileSync(path.join(sdir, 'stop'), '');
  return true;
}

function hostCommand(host, jobFile) {
  const env = { ...process.env, RDGPU_JOB: jobFile };
  if (host.kind === 'python') {
    env.PYTHONPATH = [host.modulePath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    env.RENDERDOC_PYTHON_PATH = host.modulePath;
    if (!IS_WIN) env.LD_LIBRARY_PATH = [host.modulePath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    return { cmd: host.python, args: [RDJOB, jobFile], env };
  }
  if (!IS_WIN && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) env.QT_QPA_PLATFORM = 'offscreen';
  return { cmd: host.exe, args: ['--python', RDJOB], env };
}

async function spawnJob(jobFile, full, job, opts) {
  const host = opts.hostInfo || chooseHost(opts);
  const env = { ...process.env, RDGPU_JOB: jobFile };
  let cmd;
  let args;
  if (host.kind === 'python') {
    cmd = host.python;
    args = [RDJOB, jobFile];
    env.PYTHONPATH = [host.modulePath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    env.RENDERDOC_PYTHON_PATH = host.modulePath;
    if (!IS_WIN) env.LD_LIBRARY_PATH = [host.modulePath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  } else {
    cmd = host.exe;
    args = ['--python', RDJOB];
    if (!IS_WIN && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) env.QT_QPA_PLATFORM = 'offscreen';
  }

  const timeoutMs = (opts.timeoutSec || 1800) * 1000;
  const quiet = opts.quiet || process.env.RDGPU_QUIET === '1';
  const started = Date.now();
  let offset = 0;
  let partial = '';
  const pump = () => {
    try {
      const st = fs.statSync(full.progress);
      if (st.size > offset) {
        const fd = fs.openSync(full.progress, 'r');
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = st.size;
        if (!quiet) {
          const text = partial + buf.toString('utf8');
          const lines = text.split('\n');
          partial = lines.pop();
          for (const l of lines) {
            // condensed by default: drop per-percent loading and per-100 state lines unless --verbose
            if (!opts.verbose && /loading capture (?!100%)\d+%|\] state \d+\/\d+ |^\[[^\]]*\]\s+done in |fetching counters \d+-/.test(l)) continue;
            process.stderr.write(`  rd| ${l}\n`);
          }
        }
      }
    } catch { /* not yet created */ }
  };

  if (!quiet) process.stderr.write(`[renderdoc-gpu] running ${job.tasks.map((t) => t.type || t).join(', ')} via ${host.kind}${host.exe ? ` (${host.exe})` : ''}\n`);
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const timer = setInterval(pump, 400);
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  // qrenderdoc runs --python scripts only after its startup dialogs; no progress = a modal is waiting.
  let blocked = false;
  const startupMs = (Number(process.env.RDGPU_STARTUP_TIMEOUT) || 45) * 1000;
  const watchdog = host.kind === 'qrenderdoc' ? setTimeout(() => {
    if (!fs.existsSync(full.progress)) { blocked = true; child.kill(); }
  }, startupMs) : null;
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { stderr += String(e); resolve(-1); });
    child.on('exit', (c) => resolve(c));
  });
  clearInterval(timer);
  clearTimeout(killer);
  if (watchdog) clearTimeout(watchdog);
  if (blocked) {
    throw new Error([
      `qrenderdoc started but did not run the script within ${startupMs / 1000}s: it is waiting on a dialog.`,
      'Typical causes: first launch of RenderDoc ("Anonymous Analytics" prompt), or the monthly analytics report',
      'confirmation when "manually verify before submitting" is selected.',
      'ASK THE USER to open RenderDoc (qrenderdoc) once, answer the dialog (choosing "Do not gather" or automatic',
      'submission avoids future prompts), close RenderDoc, then retry.',
    ].join('\n'));
  }
  pump();

  let result = null;
  try { result = JSON.parse(fs.readFileSync(full.result, 'utf8')); } catch { /* missing */ }
  if (!result) {
    const log = latestRenderDocLog();
    const lines = [
      timedOut ? `RenderDoc job timed out after ${Math.round((Date.now() - started) / 1000)}s (raise with --timeout <sec>).`
        : `RenderDoc exited (code ${code}) without writing a result — it most likely crashed while replaying.`,
      `job: ${jobFile}`,
    ];
    if (stderr.trim()) lines.push('stderr:', stderr.trim().split('\n').slice(-15).join('\n'));
    if (log) lines.push(`RenderDoc log ${log.file}:`, ...log.lines);
    throw new Error(lines.join('\n'));
  }
  return result;
}

export function taskResult(result, type) {
  const t = (result.tasks || []).find((x) => x.type === type);
  if (!t) return null;
  if (!t.ok) throw new Error(`${type} failed: ${t.error}\n${t.traceback || ''}`);
  return t.result;
}
