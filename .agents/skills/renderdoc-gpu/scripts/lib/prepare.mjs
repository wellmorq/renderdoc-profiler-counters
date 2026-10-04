// open / fetch: run extraction jobs and maintain the case directory.
import fs from 'node:fs';
import path from 'node:path';
import { CASE_VERSION, caseDirFor, captureStamp, loadCase } from './case.mjs';
import { expandCounterSpec } from './presets.mjs';
import { runJob, taskResult } from './runner.mjs';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function counterTask(spec, opts = {}) {
  const e = expandCounterSpec(spec);
  const label = opts.label || e.presets.join('+') || 'custom';
  return {
    type: 'counters', label: label.replace(/[^A-Za-z0-9_+-]/g, '_'),
    names: e.names, families: e.families, patterns: e.patterns,
    repeat: opts.repeat || 1, chunk: opts.chunk || 64,
  };
}

export async function openCapture(capture, opts) {
  const abs = path.resolve(capture);
  if (!fs.existsSync(abs)) throw new Error(`Capture not found: ${abs}`);
  const dir = caseDirFor(abs);
  const cur = captureStamp(abs);
  const metaPath = path.join(dir, 'case.json');
  if (!opts.force && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.version === CASE_VERSION && meta.stamp?.size === cur.size && meta.stamp?.mtimeMs === cur.mtimeMs) {
      process.stderr.write(`[renderdoc-gpu] reusing prepared case ${dir} (use --force to re-extract)\n`);
      return { dir, reused: true };
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^(counters-.*|info|shaders|resources)\.json$|^(actions|state)\.jsonl$|^thumbnail\.png$/.test(f)) fs.rmSync(path.join(dir, f));
  }
  fs.rmSync(path.join(dir, 'shaders'), { recursive: true, force: true });

  const tasks = [
    { type: 'info', thumbnail: true, required: true },
    { type: 'actions', required: true },
  ];
  const specs = String(opts.counters || 'generic,nv-pack').split(',').map((s) => s.trim()).filter(Boolean);
  // generic first and on its own so a vendor-counter failure doesn't lose durations
  const generic = specs.filter((s) => s === 'generic');
  const rest = specs.filter((s) => s !== 'generic');
  if (generic.length) tasks.push(counterTask('generic', { repeat: opts.repeat }));
  if (rest.length) tasks.push(counterTask(rest.join(','), { label: rest.join('+') }));
  if (!opts.noState) tasks.push({ type: 'state', limit: opts.stateLimit || 0 });
  if (!opts.noState && !opts.noShaders) tasks.push({ type: 'shaders', sources: true });

  const t0 = Date.now();
  const result = await runJob(path.join(dir, 'jobs', `open-${stamp()}`), { capture: abs, tasks }, { out: dir, timeoutSec: opts.timeout, host: opts.host, quiet: opts.quiet, verbose: opts.verbose });
  if (result.error && !(result.tasks || []).some((t) => t.type === 'actions' && t.ok)) {
    throw new Error(`Extraction failed: ${result.error}\n${result.traceback || ''}`);
  }
  const meta = {
    version: CASE_VERSION,
    capture: abs,
    stamp: cur,
    created: new Date().toISOString(),
    renderdoc: result.renderdocVersion,
    host: result.host,
    options: { counters: specs, repeat: opts.repeat || 1, state: !opts.noState, shaders: !opts.noState && !opts.noShaders, stateLimit: opts.stateLimit || 0 },
    tasks: (result.tasks || []).map((t) => ({ type: t.type, ok: t.ok, seconds: t.seconds, error: t.error, result: t.result })),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
  return { dir, reused: false, meta };
}

export async function fetchCounters(target, spec, opts) {
  const c = loadCase(target);
  const task = counterTask(spec, { repeat: opts.repeat, label: opts.label });
  const result = await runJob(path.join(c.dir, 'jobs', `fetch-${stamp()}`), { capture: c.meta.capture, tasks: [task] },
    { out: c.dir, timeoutSec: opts.timeout, host: opts.host, quiet: opts.quiet, verbose: opts.verbose, sessionDir: path.join(c.dir, 'session') });
  if (result.error) throw new Error(`fetch failed: ${result.error}`);
  const r = taskResult(result, 'counters');
  const meta = c.meta;
  meta.fetches = [...(meta.fetches || []), { spec, label: task.label, at: new Date().toISOString(), result: r }];
  fs.writeFileSync(path.join(c.dir, 'case.json'), JSON.stringify(meta, null, 1));
  return r;
}
