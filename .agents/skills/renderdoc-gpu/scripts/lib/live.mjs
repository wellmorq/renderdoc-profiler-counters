// Commands that need a live RenderDoc replay (each launches one job).
import fs from 'node:fs';
import path from 'node:path';
import { fmtMs, table, trunc } from './format.mjs';
import { runJob, sessionAlive, startSession, stopSession, taskResult } from './runner.mjs';
import { chooseHost } from './env.mjs';
import { closeDaemon, ensureDaemon, liveSession, sessionName } from './rdc.mjs';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function requireWork(c, eid) {
  const a = c.byEid.get(eid);
  if (!a) throw new Error(`EID ${eid} is not an action in this capture.`);
  if (a.kind !== 'draw' && a.kind !== 'dispatch') {
    const kids = c.workUnder(a).filter((x) => x.kind === 'draw' || x.kind === 'dispatch');
    const hint = kids.length ? ` Draws/dispatches inside it: ${kids.slice(0, 8).map((k) => k.eid).join(', ')}${kids.length > 8 ? ', …' : ''}` : '';
    throw new Error(`EID ${eid} (${a.name}) is a ${a.kind}, not a draw/dispatch.${hint}`);
  }
  return a;
}

async function job(c, name, tasks, opts = {}) {
  const dir = path.join(c.dir, 'jobs', `${name}-${stamp()}`);
  const res = await runJob(dir, { capture: c.meta.capture, tasks }, { out: opts.out || dir, timeoutSec: opts.timeout, host: opts.host, quiet: opts.quiet, verbose: opts.verbose, sessionDir: path.join(c.dir, 'session') });
  if (res.error) throw new Error(`${name} failed: ${res.error}\n${res.traceback || ''}`);
  return { res, dir };
}

function fmtVals(v) {
  if (!v.value) return '';
  const nums = v.value.map((x) => (typeof x === 'number' && !Number.isInteger(x) ? Number(x.toPrecision(4)) : x));
  if (v.rows > 1 && v.cols > 1) {
    const rows = [];
    for (let r = 0; r < v.rows; r++) rows.push(nums.slice(r * v.cols, (r + 1) * v.cols).join(' '));
    return `[${rows.join(' | ')}]`;
  }
  return nums.length === 1 ? String(nums[0]) : `(${nums.join(', ')})`;
}

// Flatten cbuffer variables; arrays (members named "[0]".."[n]") are shortened to their first elements.
function flattenVars(vars, prefix = '', out = [], maxArray = 8) {
  for (const v of vars || []) {
    if (v.members) {
      const isArray = v.members.length > 0 && v.members.every((m) => /^\[\d+\]$/.test(m.name) || /\[\d+\]$/.test(m.name));
      const mem = isArray && maxArray ? v.members.slice(0, maxArray) : v.members;
      const selfNamed = isArray && v.members.every((m) => m.name.startsWith(v.name));
      flattenVars(mem, selfNamed ? prefix : `${prefix}${v.name}${isArray ? '' : '.'}`, out, maxArray);
      if (isArray && maxArray && v.members.length > maxArray) out.push([`${prefix}${v.name}[${maxArray}..${v.members.length - 1}]`, `… ${v.members.length - maxArray} more elements (--all)`]);
    } else out.push([prefix + v.name, fmtVals(v)]);
  }
  return out;
}

async function drawJson(c, eid, opts) {
  requireWork(c, eid);
  const { res, dir } = await job(c, `draw${eid}`, [{ type: 'draw', eid, file: 'draw.json' }], opts);
  taskResult(res, 'draw');
  return { d: JSON.parse(fs.readFileSync(path.join(dir, 'draw.json'), 'utf8')), file: path.join(dir, 'draw.json') };
}

export async function draw(c, eid, opts) {
  const { d, file } = await drawJson(c, eid, opts);
  const out = [`EID ${eid} ${d.name} (${d.kind})  indices=${d.indices} instances=${d.instances}`];
  for (const [stage, s] of Object.entries(d.stages)) {
    out.push(`--- ${stage} shader ${c.shaderLabel(s.id)} entry=${s.entry}`);
    for (const t of s.textures || []) out.push(`  tex ${t.slot || '?'} = ${t.tex ? `${t.tex.id} ${t.tex.name || ''} ${t.tex.w ? `${t.tex.w}x${t.tex.h}` : ''} ${t.tex.fmt || ''} mips=${t.tex.mips ?? '?'}` : '-'}`);
    for (const cb of s.cbuffers || []) {
      if (cb.error) { out.push(`  cbuffer ${cb.name}: (${cb.error})`); continue; }
      const vars = flattenVars(cb.vars, '', [], opts.all ? 0 : 8);
      out.push(`  cbuffer ${cb.name} (${cb.bytes} B${cb.buffer ? `, buffer ${cb.buffer}` : ''}):`);
      for (const [n, v] of vars.slice(0, opts.all ? 100000 : 80)) out.push(`    ${n} = ${trunc(v, 160)}`);
      if (vars.length > 80 && !opts.all) out.push(`    … ${vars.length - 80} more (--all)`);
    }
  }
  if (d.rts?.length) out.push(`render targets: ${d.rts.map((t) => `${t.id} ${t.name || ''} ${t.w}x${t.h} ${t.fmt}`).join(' | ')}`);
  if (d.depthTarget) out.push(`depth: ${d.depthTarget.id} ${d.depthTarget.name || ''} ${d.depthTarget.w}x${d.depthTarget.h} ${d.depthTarget.fmt}`);
  out.push(`raw json: ${file}`);
  return out.join('\n');
}

function drawFacts(d) {
  const f = new Map();
  f.set('event', `${d.kind} indices=${d.indices} instances=${d.instances}`);
  const st = d.state || {};
  for (const k of ['topology', 'viewport', 'blend', 'blendEq', 'depth', 'cull', 'fill', 'stencil', 'vertexInputs', 'vbStrides']) if (st[k] !== undefined) f.set(`state.${k}`, JSON.stringify(st[k]));
  for (const t of d.rts || []) f.set(`rt.${t.name || t.id}`, `${t.w}x${t.h} ${t.fmt}`);
  if (d.depthTarget) f.set('depth target', `${d.depthTarget.w}x${d.depthTarget.h} ${d.depthTarget.fmt}`);
  for (const [stage, s] of Object.entries(d.stages || {})) {
    f.set(`${stage}.shader`, `entry=${s.entry} ${s.encoding}`);
    for (const t of s.textures || []) f.set(`${stage}.tex ${t.slot || '?'}`, t.tex ? `${t.tex.name || t.tex.id} ${t.tex.w}x${t.tex.h} ${t.tex.fmt || ''} mips=${t.tex.mips}` : '-');
    for (const cb of s.cbuffers || []) for (const [n, v] of flattenVars(cb.vars, '', [], 0)) f.set(`${stage}.${cb.name}.${n}`, v);
  }
  return f;
}

// Same EID (or matched event) in two captures: what differs in constants, textures, targets and state.
export async function drawdiff(a, b, eidA, eidB, opts) {
  const [x, y] = [await drawJson(a, eidA, opts), await drawJson(b, eidB, opts)];
  const fa = drawFacts(x.d); const fb = drawFacts(y.d);
  const diffs = [];
  for (const k of new Set([...fa.keys(), ...fb.keys()])) {
    const va = fa.get(k); const vb = fb.get(k);
    if (va !== vb) diffs.push([k, va ?? '(absent)', vb ?? '(absent)']);
  }
  // collapse arrays: many differing elements of one array -> one row; scalars first
  const groups = new Map();
  for (const d of diffs) {
    const base = d[0].replace(/\[\d+\]$/, '[]');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(d);
  }
  const scalar = []; const arrays = [];
  for (const [base, ds] of groups) {
    if (base.endsWith('[]') && ds.length > 2) {
      const total = [...new Set([...fa.keys(), ...fb.keys()])].filter((k) => k.replace(/\[\d+\]$/, '[]') === base).length;
      arrays.push([trunc(base, 60), `${ds.length} of ${total} elements differ`, `e.g. ${trunc(ds[0][0].match(/\[\d+\]$/)[0] + ' ' + ds[0][1] + ' → ' + ds[0][2], 60)}`]);
    } else for (const d of ds) (base.endsWith('[]') ? arrays : scalar).push([trunc(d[0], 60), trunc(d[1], 50), trunc(d[2], 50)]);
  }
  const rows = [...scalar, ...arrays];
  // changed constants that drive loops in the shader source are the usual cause of cost changes
  const loopHints = [];
  for (const [stage, s] of Object.entries(y.d.stages || {})) {
    const meta = b.shaderById.get(s.id);
    if (!meta?.sourceDir) continue;
    let text = '';
    for (const f of meta.sourceFiles || []) { try { text += fs.readFileSync(path.join(b.dir, 'shaders', meta.sourceDir, f), 'utf8') + '\n'; } catch { /* ignore */ } }
    const lines = text.split('\n').filter((l) => !/\b(uniform|cbuffer|CBUFFER_START|layout\s*\()/i.test(l));
    for (const [k] of scalar) {
      const name = k.split('.').pop().replace(/\[.*$/, '');
      if (!k.startsWith(stage + '.') || name.length < 3) continue;
      const esc = name.replace(/[$]/g, '\\$');
      const loopRe = /\b(for|while)\s*\(/;
      let hit = lines.find((l) => loopRe.test(l) && new RegExp(`\\b${esc}\\b`).test(l));
      if (!hit) {
        // indirect: v = f(name); ... for(... v ...)
        for (const l of lines) {
          const m = l.match(new RegExp(`(\\w+)\\s*=[^;=]*\\b${esc}\\b`));
          if (!m) continue;
          const loop = lines.find((x) => loopRe.test(x) && new RegExp(`\\b${m[1]}\\b`).test(x));
          if (loop) { hit = `${l.trim()}  …  ${loop.trim()}`; break; }
        }
      }
      if (hit) loopHints.push(`  ${stage} ${name}: ${trunc(hit.trim(), 140)}`);
    }
  }
  const out = [`A EID ${eidA} ${x.d.name} | B EID ${eidB} ${y.d.name}`];
  const ma = a.ms(eidA); const mb = b.ms(eidB);
  if (ma !== null && mb !== null) out.push(`GPU ${fmtMs(ma)} → ${fmtMs(mb)} ms`);
  if (!rows.length) out.push('No differences in constants, bound textures, targets or pipeline state. If timing differs, suspect shader code (compare `shader` static stats/hash), upstream data (texture contents) or timing noise (fetch --repeat).');
  else {
    out.push(`${rows.length} differences (arrays compared element by element):`);
    out.push(table(['what', 'A', 'B'], rows.slice(0, opts.all ? 100000 : 60), 'lll'));
    if (rows.length > 60 && !opts.all) out.push(`… ${rows.length - 60} more (--all)`);
    if (loopHints.length) out.push('LIKELY COST DRIVERS (changed constant controls a loop in the shader source):', ...loopHints);
  }
  return out.join('\n');
}

export async function rt(c, eid, opts) {
  requireWork(c, eid);
  const imgDir = path.join(c.dir, 'images');
  const which = opts.depth ? 'depth' : opts.all ? 'all' : 'color';
  const { res } = await job(c, `rt${eid}`, [{ type: 'save_rt', eid, dir: imgDir, which, resource: opts.resource }], opts);
  const r = taskResult(res, 'save_rt');
  if (!r.images.length) return `EID ${eid} has no ${which} targets bound.`;
  return r.images.map((i) => (i.error ? `${i.label} ${i.id}: ERROR ${i.error}` : `${i.label}: ${i.path}  (${i.texture?.name || ''} ${i.texture?.w}x${i.texture?.h} ${i.texture?.fmt || ''})`)).join('\n')
    + '\nImages show the target state AFTER this event. Open them with your image/file viewing tool.';
}

export async function source(c, eid, opts) {
  requireWork(c, eid);
  const stage = opts.stage || (c.byEid.get(eid).kind === 'dispatch' ? 'cs' : 'ps');
  const name = (opts.as || 'original').replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = path.resolve(opts.out || path.join(c.dir, 'edit', `eid${eid}-${stage}`, name));
  fs.rmSync(dir, { recursive: true, force: true });
  const { res } = await job(c, `source${eid}`, [{ type: 'dump_source', eid, stage, dir }], opts);
  const m = taskResult(res, 'dump_source');
  const out = [`${stage} shader ${m.shader} at EID ${eid}: entry=${m.entry} encoding=${m.encoding} source=${m.sourceEncoding}`];
  const cmd = (m.flags || []).find((f) => f[0] === '@cmdline');
  if (cmd) out.push(`compile flags: ${cmd[1]}`);
  if (m.note) {
    out.push(m.note, `disassembly: ${path.join(dir, 'disassembly.txt')}`,
      'Without embedded source you must write a replacement shader by hand (same entry, inputs/outputs and bindings). Prefer recapturing with debug info (references/unity-shaders.md).');
  } else {
    out.push(`source tree: ${dir}`, `main file: ${path.join(dir, m.main)}`, ...m.files.slice(1, 10).map((f) => `  include: ${f}`));
    if (name === 'original') {
      out.push('', 'To experiment: create an editable copy per variant (same command with --as <name>), edit its main file, then:',
        `  source <capture> ${eid} --stage ${stage} --as v1`,
        `  experiment <capture> ${eid} --stage ${stage} --variant v1=${path.join(path.dirname(dir), 'v1', m.main)}`);
    } else {
      out.push('', `Edit ${path.join(dir, m.main)} (keep entry point, inputs/outputs, bindings), then:`,
        `  experiment <capture> ${eid} --stage ${stage} --variant ${name}=${path.join(dir, m.main)}`);
    }
  }
  return out.join('\n');
}

function parseVariants(list) {
  const out = [];
  for (const v of list || []) {
    const i = v.indexOf('=');
    if (i <= 0) throw new Error(`--variant expects label=path-to-main-source-file (or label=original), got "${v}"`);
    const label = v.slice(0, i).replace(/[^A-Za-z0-9_.-]/g, '_');
    const p = v.slice(i + 1);
    if (p === 'original') out.push({ label, original: true });
    else {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) throw new Error(`variant source not found: ${abs}`);
      out.push({ label, file: abs });
    }
  }
  return out;
}

export async function experiment(c, eid, opts) {
  requireWork(c, eid);
  const stage = opts.stage || (c.byEid.get(eid).kind === 'dispatch' ? 'cs' : 'ps');
  const flags = {
    remove: (opts.flagsRemove || []).flatMap((s) => s.split(',')).filter(Boolean),
    add: (opts.flagsAdd || []).flatMap((s) => s.split(',')).filter(Boolean),
  };
  let variants = parseVariants(opts.variant);
  if (!variants.some((v) => v.original) && !opts.noOriginal) variants.unshift({ label: 'original', original: true });
  variants = variants.map((v) => ({ ...v, flags, encoding: opts.encoding, entry: opts.entry }));
  const counters = opts.counters ? opts.counters.split(',').map((s) => s.trim()) : ['GPU Duration'];
  const imgDir = opts.images ? path.join(c.dir, 'images', `exp-eid${eid}-${stamp()}`) : null;
  // events sharing the shader come from the cached pipeline state (saves a full state scan in replay)
  const sid = c.shaderOf(eid, stage);
  const users = sid === undefined ? null : [...c.state.values()].filter((st) => st.shaders && st.shaders[stage] === sid).map((st) => st.eid);
  const { res, dir } = await job(c, `exp${eid}`, [{
    type: 'experiment', eid, stage, variants, counters, repeat: opts.repeat || (/software|llvmpipe|warp/i.test(c.info.vendor || '') ? 7 : 5), imageDir: imgDir, file: 'experiment.json',
    users: users && users.length ? users : undefined, scanUsers: !(users && users.length),
  }], opts);
  taskResult(res, 'experiment');
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'experiment.json'), 'utf8'));
  const out = [`EXPERIMENT eid ${eid} ${stage} shader ${r.shader} (entry ${r.entry}, ${r.encoding}); the replacement affects ${r.usersOfShader.length} event(s) using this shader: ${r.usersOfShader.slice(0, 12).join(',')}${r.usersOfShader.length > 12 ? ',…' : ''}`];
  const cmd = (r.originalFlags || []).find((f) => f[0] === '@cmdline');
  if (cmd) out.push(`captured compile flags: ${cmd[1] || '(none)'}`);
  if (r.missingCounters?.length) out.push(`missing counters: ${r.missingCounters.join(', ')}`);
  const main = counters.find((n) => !r.missingCounters?.includes(n)) || counters[0];
  const metricOf = (v) => v.metrics?.[main];
  const orig = r.variants.find((v) => v.label === 'original');
  const base = orig && metricOf(orig) ? orig : r.variants[0];
  const baseM = metricOf(base);
  const pe = (v, e) => metricOf(v)?.perEvent?.[String(e)];
  const overlaps = (p, q) => p && q && !(p.max < q.min || q.max < p.min);
  const rows = r.variants.map((v) => {
    const m = metricOf(v);
    if (!m) return [v.label, v.error ? 'FAILED' : '-', '', '', '', '', '', ''];
    const p = pe(v, eid);
    const d = (x, y) => (x && y ? `${(((y - x) / x) * 100).toFixed(1)}%` : '');
    const sig = v === base ? '' : (overlaps(p, pe(base, eid)) ? 'no (ranges overlap)' : 'yes');
    const o = v.output || {};
    const img = o.error ? 'n/a' : o.changedPct === undefined || o.changedPct === null ? '-'
      : `${o.changedPct}%${o.visiblePct !== undefined && o.changedPct > 0 ? ` (>1/255: ${o.visiblePct}%)` : ''}${o.maxAbs !== undefined && o.changedPct > 0 ? ` max ${o.maxAbs} mean ${o.meanAbs}${o.psnr ? ` psnr ${o.psnr}dB` : ''}` : ''}`;
    return [v.label, p ? `${fmtMs(p.median)} [${fmtMs(p.min)}–${fmtMs(p.max)}]` : '-', fmtMs(m.targetSum),
      v === base ? '' : d(baseM?.targetSum, m.targetSum), sig, img, v.image ? path.basename(v.image) : ''];
  });
  out.push(`metric: ${main} (${baseM?.unit || ''}), median [min–max] of ${r.repeat} replays; baseline = "${base.label}"`);
  out.push(table(['variant', `eid ${eid}`, 'all users', `Δ users vs ${base.label}`, 'significant', 'image vs captured', 'png'], rows, 'lrrrlll'));
  if (r.usersOfShader.length > 1 && r.usersOfShader.length <= 12) {
    out.push('per event (median):');
    out.push(table(['variant', ...r.usersOfShader.map((e) => `eid ${e}`)], r.variants.filter((v) => metricOf(v)).map((v) => [v.label, ...r.usersOfShader.map((e) => fmtMs(pe(v, e)?.median))]), 'l' + 'r'.repeat(r.usersOfShader.length)));
  }
  for (const v of r.variants.slice(1)) {
    if (v.error) out.push(`--- ${v.label}: ${v.error}\n${(v.compilerOutput || '').split('\n').slice(0, 25).join('\n')}`);
    else if (v.compilerOutput && /warning|error/i.test(v.compilerOutput)) out.push(`--- ${v.label} compiler output:\n${v.compilerOutput.split('\n').slice(0, 10).join('\n')}`);
  }
  const fl = r.variants.find((v) => v.flags)?.flags?.find((x) => x[0] === '@cmdline');
  if (fl) out.push(`variants compiled with: ${fl[1]}`);
  out.push('Judge variants against "original" (same compiler + flags). significant=yes: min–max ranges do not overlap. If they overlap, rerun with a higher --repeat.');
  out.push('image vs captured: % of render-target-0 texels that differ after this event (and % differing by more than 1/255 — the visible part), max/mean absolute error per channel (float, linear) and PSNR. 0% = identical. Only the first event\'s target is compared.');
  if (imgDir) out.push(`images: ${imgDir}`);
  out.push(`raw json: ${path.join(dir, 'experiment.json')}`);
  return out.join('\n');
}

export async function usage(c, resId, opts) {
  const { res } = await job(c, `usage${resId}`, [{ type: 'usage', resource: resId }], opts);
  const r = taskResult(res, 'usage');
  const rows = r.usage.map((u) => {
    const a = c.byEid.get(u.eid);
    return [u.eid, u.usage, a ? trunc(a.name, 40) : '', a ? trunc(c.markerPathOf(a).join(' > '), 60) : ''];
  });
  return `resource ${c.texLabel(resId)} — ${rows.length} uses\n` + table(['eid', 'usage', 'event', 'marker path'], rows.slice(0, opts.n || 60), 'rlll');
}

export async function session(c, opts) {
  const host = chooseHost(opts);
  if (host.kind === 'rdc') {
    const name = sessionName(c.meta.capture);
    if (opts.stop) return closeDaemon(c.meta.capture, { rdc: host.exe }) ? `rdc session ${name} closed` : 'no rdc session running';
    const was = await liveSession(c.meta.capture);
    await ensureDaemon(c.meta.capture, { rdc: host.exe, quiet: opts.quiet });
    return `${was ? 'rdc session already open' : 'rdc session open'}: ${name}. Live commands reuse it; you can also call rdc-cli directly on the same capture:\n  rdc --session ${name} <command>   (pipeline <eid>, bindings <eid>, debug pixel <eid> <x> <y>, pixel <x> <y>, mesh <eid>, cbuffer, tex-stats, ...)\nIt closes after 30 min idle or with \`session <rdc> --stop\`.`;
  }
  const sdir = path.join(c.dir, 'session');
  if (opts.stop) {
    if (!stopSession(sdir)) return 'no session running';
    const until = Date.now() + 15000;
    while (Date.now() < until && sessionAlive(sdir)) await new Promise((r) => setTimeout(r, 200));
    return sessionAlive(sdir) ? 'session stopping after its running job finishes (new live commands load the capture themselves meanwhile)' : 'session stopped';
  }
  if (fs.existsSync(path.join(sdir, 'stop'))) {
    const until = Date.now() + 15000;
    while (Date.now() < until && sessionAlive(sdir)) await new Promise((r) => setTimeout(r, 200));
  }
  const a = sessionAlive(sdir, c.meta.capture);
  if (a) return `session already running (pid ${a.pid}, ${a.served} job(s) served, idle timeout ${a.idle}s)`;
  const t0 = Date.now();
  const { pid } = startSession(sdir, c.meta.capture, { idle: opts.idle, host: opts.host });
  const deadline = Date.now() + (opts.timeout || 600) * 1000;
  let offset = 0;
  const log = path.join(sdir, 'session.log');
  while (Date.now() < deadline) {
    if (!opts.quiet) {
      try {
        const st = fs.statSync(log);
        if (st.size > offset) {
          const fd = fs.openSync(log, 'r'); const buf = Buffer.alloc(st.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); offset = st.size;
          for (const l of buf.toString('utf8').split('\n').filter(Boolean)) if (!/loading capture (?!100%)/.test(l)) process.stderr.write(`  rd| ${l}\n`);
        }
      } catch { /* not yet */ }
    }
    if (sessionAlive(sdir, c.meta.capture)) {
      return `session ready in ${Math.round((Date.now() - t0) / 1000)}s (pid ${pid}). Live commands on this capture now skip loading; it exits after ${opts.idle || 900}s without jobs or with \`session <rdc> --stop\`.`;
    }
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`session did not start; see ${log}`);
}
