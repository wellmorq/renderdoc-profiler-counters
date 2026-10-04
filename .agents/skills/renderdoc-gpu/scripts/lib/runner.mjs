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
  const quiet = opts.quiet;
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
          for (const l of lines) process.stderr.write(`  rd| ${l}\n`);
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
