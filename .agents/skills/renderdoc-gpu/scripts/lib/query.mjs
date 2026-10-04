// Offline queries over a prepared case. Output is compact text meant for an agent's context.
import fs from 'node:fs';
import path from 'node:path';
import { GENERIC_HELP, WORK_KINDS, counterKind } from './case.mjs';
import { bar, fmtMs, fmtNum, fmtPct, table, trunc } from './format.mjs';
import { isDebugCompiled, shaderStats, statsLabel } from './shaderstats.mjs';

const stripHtml = (s) => String(s || '').replace(/<br\/?>/g, '; ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export function shortMetric(k) {
  return k
    .replace(/^smsp__warp_issue_stalled_(.*)_per_warp_active\.avg\.pct$/, 'stall_$1%')
    .replace(/^smsp__inst_executed_shader_(\w+)\.sum$/, 'inst_$1')
    .replace(/^sm__inst_executed\.sum$/, 'inst')
    .replace(/^dram__bytes_op_read\.sum$/, 'dramRd')
    .replace(/^dram__bytes_op_write\.sum$/, 'dramWr')
    .replace(/^l1tex__t_sector_hit_rate\.avg\.pct$/, 'L1hit%')
    .replace(/^lts__t_sector_hit_rate\.avg\.pct$/, 'L2hit%')
    .replace(/^gpu__time_duration\.sum$/, 'nvTime_ns');
}

// Marker path, keeping the innermost (most specific) markers when it must be shortened.
export function pathStr(c, a, max = 70) {
  const p = c.markerPathOf(a);
  let s = p.join(' > ');
  if (s.length <= max) return s;
  const parts = [...p];
  while (parts.length > 1 && ('… > ' + parts.join(' > ')).length > max) parts.shift();
  s = '… > ' + parts.join(' > ');
  return s.length > max ? '…' + s.slice(s.length - max + 1) : s;
}

function workSummary(c) {
  const ev = c.actions;
  const n = (k) => ev.filter((a) => a.kind === k).length;
  return { draws: n('draw'), dispatches: n('dispatch'), clears: n('clear'), copies: n('copy'), markers: n('marker') };
}

export function counterStatus(c) {
  const lines = [];
  const fam = {};
  for (const x of c.catalog.values()) fam[x.family] = (fam[x.family] || 0) + 1;
  const nvErr = (c.info.counterErrors || []).find((e) => /Nsight Perf/i.test(e));
  for (const s of c.counterSources) {
    if (!s.counters) { if (s.missing.length) lines.push(`${s.label}: none fetched; missing ${s.missing.slice(0, 4).join(', ')}`); continue; }
    lines.push(`${s.label}: ${s.counters} counters${s.repeat > 1 ? ` (median of ${s.repeat} runs)` : ''}${s.missing.length ? `, missing ${s.missing.length}: ${s.missing.slice(0, 4).join(', ')}${s.missing.length > 4 ? ', …' : ''}` : ''}`);
  }
  if (nvErr) {
    lines.push(`NVIDIA counters UNAVAILABLE: "${nvErr}" -> run \`setup-nvperf\`, then \`open --force\` or \`fetch nv-pack\``);
  } else if (c.info.vendor === 'nVidia' || c.info.vendor === 'NVIDIA' || fam.nvidia) {
    if (!fam.nvidia) lines.push('NVIDIA GPU but no NVIDIA counters enumerated (unsupported GPU/driver?)');
    else lines.push(`NVIDIA counters available: ${fam.nvidia} (fetch more with \`fetch <capture> <preset|names>\`)`);
  } else {
    lines.push(`vendor counters: ${Object.entries(fam).filter(([k]) => k !== 'generic').map(([k, v]) => `${k} ${v}`).join(', ') || 'none for this GPU/API'}`);
  }
  return lines;
}

export function engineHint(c) {
  const names = new Set(c.actions.filter((a) => a.children > 0).map((a) => a.name));
  const has = (re) => [...names].some((n) => re.test(n));
  let eng = null;
  if (has(/HDRenderPipeline|HDRP/)) eng = 'Unity HDRP';
  else if (has(/UniversalRenderPipeline|DrawOpaqueObjects|RenderSingleCamera/)) eng = 'Unity URP';
  else if (has(/^(Camera\.Render|RenderLoop\.|Render\.OpaqueGeometry|Drawing$)/)) eng = 'Unity (built-in pipeline)';
  if (!eng) return null;
  const editor = has(/^(GUI\.|UIR\.|EditorLoop|GUIView|Gizmos|SceneView)/);
  return eng + (editor ? ' — EDITOR capture: editor UI/scene-view work (GUI.*, UIR.*, Gizmos) is included; analyse the game camera markers, not the editor ones' : '');
}

export function summary(c, opts = {}) {
  const w = workSummary(c);
  const frame = c.frameMs();
  const size = c.meta.stamp?.size ? `${(c.meta.stamp.size / 1048576).toFixed(1)} MB` : '';
  const out = [];
  out.push(`CAPTURE  ${c.meta.capture} ${size ? `(${size})` : ''}`);
  out.push(`API      ${c.info.api || '?'} | replay GPU vendor ${c.info.vendor || '?'} | RenderDoc ${c.info.renderdocVersion || c.meta.renderdoc || '?'} via ${c.meta.host || '?'}${c.info.degraded ? ' | DEGRADED replay (results less reliable)' : ''}`);
  if (c.info.driverAtCapture) out.push(`CAPTURED ${c.info.driverAtCapture}${c.info.machineAtCapture ? ' on ' + c.info.machineAtCapture : ''}`);
  if (fs.existsSync(path.join(c.dir, 'thumbnail.png'))) out.push(`THUMB    ${path.join(c.dir, 'thumbnail.png')} (what the frame looks like)`);
  out.push(`FRAME    ${c.actions.length} actions: ${w.draws} draws, ${w.dispatches} dispatches, ${w.clears} clears, ${w.copies} copies, ${w.markers} markers`);
  out.push(`GPU      ${frame === null ? 'no durations measured' : fmtMs(frame) + ' ms = sum of per-event GPU durations (replay; not the game\'s frame time)'}`);
  const eng = engineHint(c);
  if (eng) out.push(`ENGINE   ${eng}`);
  for (const l of counterStatus(c)) out.push(`COUNTERS ${l}`);
  if (c.shaders.length) {
    const by = {};
    for (const s of c.shaders) by[s.stage] = (by[s.stage] || 0) + 1;
    const withSrc = c.shaders.filter((s) => s.sourceDebugInfo || (s.files || []).length).length;
    const od = c.shaders.filter(isDebugCompiled).length;
    out.push(`SHADERS  ${c.shaders.length} unique (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}); with embedded source: ${withSrc}${od ? `; compiled WITHOUT optimisation (/Od): ${od} — their timings are pessimistic` : ''}`);
  } else if (c.meta.options?.shaders === false) {
    out.push('SHADERS  not extracted (--no-state/--no-shaders)');
  }
  const failed = (c.meta.tasks || []).filter((t) => !t.ok);
  for (const t of failed) out.push(`WARNING  extraction step "${t.type}" failed: ${t.error}`);
  const msgs = (c.info.debugMessages || []).filter((m) => /High|Medium/.test(m.severity));
  if (msgs.length) out.push(`API MSGS ${msgs.length} high/medium debug messages (see info.json)`);

  if (frame !== null) {
    // Zoom through wrappers that hold almost all of the time (Unity editor: UIR.DrawChain, camera roots).
    let level = c.roots;
    const focus = [];
    for (;;) {
      const groups = level.filter((a) => a.children > 0);
      const dom = groups.find((a) => (c.nodeAgg(a).ms || 0) >= frame * 0.85);
      if (!dom) break;
      const kidsG = c.kids(dom).filter((k) => k.children > 0);
      if (!kidsG.length) break;
      focus.push(dom);
      level = c.kids(dom);
      if (focus.length > 6) break;
    }
    out.push('', `PASSES (inclusive GPU ms, replay order; markers ≥1% of frame, 2 levels${focus.length ? ' below the dominant wrapper' : ''})`);
    if (focus.length) out.push(`focus: ${focus.map((f) => `${trunc(f.name, 60)} @${f.eid} (${fmtPct(((c.nodeAgg(f).ms || 0) / frame) * 100)})`).join(' > ')}`);
    const rows = [];
    const visit = (a, depth) => {
      if (a.kind !== 'marker' && !(a.children > 0)) return;
      const ag = c.nodeAgg(a);
      if (ag.ms === null || ag.ms < frame * 0.01) return;
      rows.push([fmtMs(ag.ms), fmtPct((ag.ms / frame) * 100), ag.draws, ag.dispatches, '  '.repeat(depth) + trunc(a.name, 70) + ` @${a.eid}`]);
      if (depth < 1) for (const k of c.kids(a)) visit(k, depth + 1);
    };
    for (const r of level) visit(r, 0);
    const loose = level.filter((r) => WORK_KINDS.has(r.kind));
    const looseMs = loose.reduce((s, a) => s + (c.ms(a.eid) || 0), 0);
    if (loose.length && looseMs >= frame * 0.01) rows.push([fmtMs(looseMs), fmtPct((looseMs / frame) * 100), loose.filter((a) => a.kind === 'draw').length, loose.filter((a) => a.kind === 'dispatch').length, '(events outside any marker at this level)']);
    out.push(table(['ms', '%frame', 'draws', 'disp', 'marker @eid'], rows, 'rrrrl'));

    out.push('', 'TOP EVENTS');
    out.push(topTable(c, { n: opts.n || 8, by: 'ms' }));
    const sh = shaderRanking(c, { stages: ['ps', 'cs'] });
    if (sh.length) {
      out.push('', 'TOP SHADERS (ps/cs; GPU ms of the draws/dispatches that use them)');
      out.push(shaderTable(c, sh.slice(0, opts.n || 6), frame));
    }
  }
  out.push('', 'NEXT  tree <capture> [marker] | top <capture> --in <marker> | event <capture> <eid> | shaders <capture> | shader <capture> <id>');
  return out.join('\n');
}

export function topTable(c, { n = 20, by = 'ms', within = null, kinds = ['draw', 'dispatch', 'clear', 'copy'] } = {}) {
  const key = by === 'ms' ? 'ms' : c.resolveMetric(by);
  let evs = within ? within : c.frameEvents();
  evs = evs.filter((a) => kinds.includes(a.kind));
  const val = (a) => (key === 'ms' ? c.ms(a.eid) : c.get(a.eid, key));
  evs = evs.filter((a) => val(a) !== null && val(a) !== undefined).sort((x, y) => val(y) - val(x)).slice(0, n);
  const frame = c.frameMs() || 0;
  const extra = ['ps', 'verts', 'samples'].filter((k) => c.hasMetric(k) && k !== key);
  const rows = evs.map((a) => {
    const st = c.state.get(a.eid) || {};
    const sh = st.shaders ? (st.shaders.ps ?? st.shaders.cs) : undefined;
    const vp = st.viewport ? `${Math.round(st.viewport[2])}x${Math.round(st.viewport[3])}` : '';
    const msv = c.ms(a.eid);
    return [a.eid, fmtMs(msv), frame ? fmtPct((msv / frame) * 100) : '-', ...(key !== 'ms' ? [fmtNum(val(a))] : []),
      ...extra.map((k) => fmtNum(c.get(a.eid, k))), a.kind === 'dispatch' ? 'disp' : a.kind,
      sh !== undefined ? trunc(c.shaderLabel(sh), 28) : '', vp, trunc(a.name, 34), pathStr(c, a, 60)];
  });
  return table(['eid', 'ms', '%frame', ...(key !== 'ms' ? [shortMetric(key)] : []), ...extra, 'kind', 'ps/cs shader', 'vp', 'name', 'marker path'], rows, 'rrrrrrrlllll');
}

export function tree(c, query, opts = {}) {
  const nodes = c.findNodes(query);
  if (!nodes.length) return `No marker or event matches "${query}". Try \`find <capture> ${query}\`.`;
  const frame = c.frameMs() || 0;
  const depth = opts.depth ?? 2;
  const topN = opts.top ?? 12;
  const minPct = opts.minPct ?? 0;
  const metrics = (opts.metrics || []).map((m) => c.resolveMetric(m));
  const lines = [];
  const header = ['ms', '%frame', 'draws', 'disp', ...metrics.map(shortMetric), 'name @eid'];
  const rows = [];
  const fmtAgg = (evs) => {
    const ag = c.aggregate(evs, metrics);
    return metrics.map((m) => (ag[m].v === null ? '-' : (ag[m].how === 'wavg' ? '~' : '') + fmtNum(ag[m].v)));
  };
  const visit = (a, d) => {
    const isGroup = a.children > 0;
    const ag = isGroup ? c.nodeAgg(a) : { ms: c.ms(a.eid), draws: a.kind === 'draw' ? 1 : 0, dispatches: a.kind === 'dispatch' ? 1 : 0, events: [a] };
    if (!isGroup && !WORK_KINDS.has(a.kind)) return;
    // Unity-style "one marker per draw": print marker and its single draw on one line
    const kidsAll = isGroup ? c.kids(a).filter((k) => k.children > 0 || WORK_KINDS.has(k.kind)) : [];
    if (isGroup && kidsAll.length === 1 && !(kidsAll[0].children > 0)) {
      const k = kidsAll[0];
      rows.push([fmtMs(ag.ms), frame && ag.ms !== null ? fmtPct((ag.ms / frame) * 100) : '-', ag.draws, ag.dispatches, ...fmtAgg(ag.events),
        '  '.repeat(d) + trunc(a.name, 70) + ` @${a.eid} → [${k.kind}] ${trunc(k.name, 40)} @${k.eid}`]);
      return;
    }
    rows.push([fmtMs(ag.ms), frame && ag.ms !== null ? fmtPct((ag.ms / frame) * 100) : '-', ag.draws, ag.dispatches, ...fmtAgg(ag.events),
      '  '.repeat(d) + (isGroup ? '' : `[${a.kind}] `) + trunc(a.name, 80) + ` @${a.eid}`]);
    if (!isGroup || d >= depth) return;
    let kids = c.kids(a).filter((k) => k.children > 0 || WORK_KINDS.has(k.kind));
    if (minPct && frame) kids = kids.filter((k) => ((k.children > 0 ? c.nodeAgg(k).ms : c.ms(k.eid)) || 0) >= (frame * minPct) / 100);
    if (kids.length > topN) {
      const msOf = (k) => (k.children > 0 ? c.nodeAgg(k).ms : c.ms(k.eid)) || 0;
      const keep = new Set([...kids].sort((x, y) => msOf(y) - msOf(x)).slice(0, topN).map((k) => k.eid));
      const hidden = kids.filter((k) => !keep.has(k.eid));
      kids.filter((k) => keep.has(k.eid)).forEach((k) => visit(k, d + 1));
      const hms = hidden.reduce((s, k) => s + msOf(k), 0);
      rows.push([fmtMs(hms), frame ? fmtPct((hms / frame) * 100) : '-', '', '', ...metrics.map(() => ''), '  '.repeat(d + 1) + `… ${hidden.length} more siblings (use --top N)`]);
    } else {
      kids.forEach((k) => visit(k, d + 1));
    }
  };
  for (const n of nodes.slice(0, opts.maxRoots ?? 6)) visit(n, 0);
  lines.push(table(header, rows, 'rrrr' + 'r'.repeat(metrics.length) + 'l'));
  if (nodes.length > (opts.maxRoots ?? 6)) lines.push(`(${nodes.length - (opts.maxRoots ?? 6)} more matching roots not shown)`);
  if (query && nodes.length > 1) {
    const evs = nodes.flatMap((n) => c.workUnder(n));
    const ms = evs.reduce((s, e) => s + (c.ms(e.eid) || 0), 0);
    lines.push(`${nodes.length} matches for "${query}", combined ${fmtMs(ms)} ms (${frame ? fmtPct((ms / frame) * 100) : '-'})`);
  }
  if (metrics.some((m) => counterKind(m, c.units[m]) === 'wavg')) lines.push('~ = duration-weighted average of child events (estimate, not a marker-wide recomputation)');
  return lines.join('\n');
}

function derived(c, eid) {
  const v = c.values.get(eid) || {};
  const st = c.state.get(eid) || {};
  const d = [];
  const ms = c.ms(eid);
  if (st.viewport && v.ps !== undefined) {
    const px = st.viewport[2] * st.viewport[3];
    if (px > 0) d.push(`ps invocations / viewport pixels = ${(v.ps / px).toFixed(2)} (≈ shaded-pixel coverage incl. overdraw; quads/MSAA inflate it)`);
  }
  if (ms && v.ps) d.push(`ns per ps invocation = ${((ms * 1e6) / v.ps).toFixed(3)}`);
  if (v.rastPrims !== undefined && v.ps) d.push(`ps invocations per rasterized primitive = ${(v.ps / Math.max(1, v.rastPrims)).toFixed(1)}`);
  if (v.verts && v.vs !== undefined) d.push(`vs invocations / input vertices = ${(v.vs / v.verts).toFixed(2)} (<1 = post-transform cache reuse)`);
  if (v.samples !== undefined && v.ps) d.push(`samples passed / ps invocations = ${(v.samples / v.ps).toFixed(2)}`);
  if (v['smsp__inst_executed_shader_ps.sum'] && v.ps) d.push(`ps warp-instructions per ps invocation = ${(v['smsp__inst_executed_shader_ps.sum'] / v.ps).toFixed(2)} (×32 ≈ per-thread instructions if warps were full)`);
  if (v['dram__bytes_op_read.sum'] !== undefined && ms) d.push(`DRAM read bandwidth ≈ ${(v['dram__bytes_op_read.sum'] / (ms / 1000) / 1e9).toFixed(1)} GB/s`);
  return d;
}

export function event(c, eid) {
  const a = c.byEid.get(eid);
  if (!a) return `EID ${eid} is not an action in this capture (actions are draws/dispatches/clears/copies/markers).`;
  const out = [];
  const frame = c.frameMs();
  out.push(`EID ${eid}  ${a.kind}  ${a.name}`);
  out.push(`path: ${c.markerPathOf(a).join(' > ') || '(root)'}`);
  if (a.children > 0) {
    const ag = c.nodeAgg(a);
    out.push(`marker: ${a.children} children, ${ag.draws} draws, ${ag.dispatches} dispatches, ${fmtMs(ag.ms)} ms inclusive — use \`tree\`/\`top --in ${eid}\``);
    return out.join('\n');
  }
  if (a.kind === 'draw') out.push(`indices/vertices: ${a.indices}  instances: ${a.instances}`);
  if (a.kind === 'dispatch') out.push(`groups: ${(a.groups || []).join('x')}${a.threads ? '  threads: ' + a.threads.join('x') : ''}`);
  out.push(`flags: ${(a.flags || []).join(' ')}`);
  const v = c.values.get(eid);
  if (!v) {
    out.push('counters: not measured for this event');
  } else {
    const ms = c.ms(eid);
    out.push(`GPU: ${fmtMs(ms)} ms${frame ? ` (${fmtPct((ms / frame) * 100)} of frame)` : ''}`);
    const gen = Object.keys(GENERIC_HELP).filter((k) => k !== 'ms' && v[k] !== undefined && v[k] !== 0).map((k) => `${k}=${fmtNum(v[k])}`);
    out.push(`work: ${gen.join('  ') || 'all generic counters zero'}`);
    const vendor = Object.keys(v).filter((k) => !(k in GENERIC_HELP)).sort();
    if (vendor.length) {
      out.push('vendor counters:');
      out.push(table(['counter', 'value', 'unit'], vendor.map((k) => [k, fmtNum(v[k]), c.units[k] || '']), 'lrl'));
    }
    const d = derived(c, eid);
    if (d.length) out.push('derived:', ...d.map((x) => '  ' + x));
  }
  const st = c.state.get(eid);
  if (st) {
    out.push('state:');
    for (const [stage, id] of Object.entries(st.shaders || {})) {
      const s = c.shaderById.get(id);
      out.push(`  ${stage}: ${c.shaderLabel(id)}${s ? `  [${s.encoding}${s.sourceDebugInfo || (s.files || []).length ? ', source' : ''}${isDebugCompiled(s) ? ', /Od' : ''}; ${statsLabel(shaderStats(c, s))}]` : ''}`);
    }
    if (st.rts) out.push(`  render targets: ${st.rts.map((r) => c.texLabel(r)).join(' | ')}`);
    if (st.depthTarget) out.push(`  depth target: ${c.texLabel(st.depthTarget)}`);
    if (st.viewport) out.push(`  viewport: ${st.viewport[2]}x${st.viewport[3]}  topology: ${st.topology}`);
    const ds = st.depth ? `depth test=${st.depth.test} write=${st.depth.write} func=${st.depth.func}` : '';
    out.push(`  ${ds}${st.blend ? `  blend=${st.blend.map((b) => (b ? 'on' : 'off')).join(',')}${st.blendEq ? ` (${st.blendEq})` : ''}` : ''}${st.cull ? `  cull=${st.cull}` : ''}${st.stencil ? '  stencil=on' : ''}`);
    if (st.vertexInputs !== undefined) out.push(`  vertex inputs: ${st.vertexInputs}${st.vbStrides ? `  vb strides: ${st.vbStrides.join(',')}` : ''}`);
    for (const [stage, ids] of Object.entries(st.srv || {})) out.push(`  ${stage} reads: ${ids.slice(0, 12).map((r) => c.texLabel(r)).join(' | ')}${ids.length > 12 ? ` (+${ids.length - 12})` : ''}`);
    for (const [stage, ids] of Object.entries(st.uav || {})) out.push(`  ${stage} writes (UAV): ${ids.map((r) => c.texLabel(r)).join(' | ')}`);
    if (st.error) out.push(`  (state error: ${st.error})`);
  }
  out.push(`NEXT  draw <capture> ${eid} (cbuffer values, texture slots) | rt <capture> ${eid} (PNG) | shader <capture> <id>`);
  return out.join('\n');
}

export function shaderRanking(c, { stages = ['ps', 'cs'], within = null } = {}) {
  const evs = (within || c.frameEvents()).filter((a) => a.kind === 'draw' || a.kind === 'dispatch');
  const by = new Map();
  for (const a of evs) {
    const st = c.state.get(a.eid);
    if (!st || !st.shaders) continue;
    for (const stage of stages) {
      const id = st.shaders[stage];
      if (id === undefined) continue;
      const k = `${stage}:${id}`;
      let r = by.get(k);
      if (!r) { r = { id, stage, ms: 0, uses: 0, ps: 0, measured: 0, eids: [] }; by.set(k, r); }
      const m = c.ms(a.eid);
      r.uses++;
      r.eids.push(a.eid);
      if (m !== null) { r.ms += m; r.measured++; }
      const p = c.get(a.eid, stage === 'cs' ? 'cs' : 'ps');
      if (p) r.ps += p;
    }
  }
  return [...by.values()].sort((x, y) => y.ms - x.ms);
}

export function shaderTable(c, rows, frame) {
  return table(['shader', 'stage', 'ms', '%frame', 'uses', 'threads', 'ns/thread', 'static', 'src', 'name'],
    rows.map((r) => {
      const s = c.shaderById.get(r.id) || {};
      return [r.id, r.stage, fmtMs(r.ms), frame ? fmtPct((r.ms / frame) * 100) : '-', r.uses, fmtNum(r.ps),
        r.ps ? ((r.ms * 1e6) / r.ps).toFixed(2) : '-', statsLabel(shaderStats(c, s)),
        (s.sourceDebugInfo || (s.files || []).length) ? (isDebugCompiled(s) ? 'yes,/Od' : 'yes') : 'no', trunc(s.name || '', 40)];
    }), 'rlrrrrrlll');
}

export function shaders(c, opts = {}) {
  const stages = opts.stage ? opts.stage.split(',') : ['ps', 'cs'];
  const within = opts.within ? opts.within.flatMap((n) => c.workUnder(n)) : null;
  const rows = shaderRanking(c, { stages, within });
  if (!rows.length) return c.shaders.length ? 'No shaders used by measured draws in this scope.' : 'No shader data (case opened with --no-state?).';
  const out = [shaderTable(c, rows.slice(0, opts.n || 25), c.frameMs())];
  out.push('ms = summed GPU time of every draw/dispatch using the shader; a draw counts for each of its stages, so do not add ps+vs rows.');
  out.push('threads = ps or cs invocations; static = disassembly text stats (instr slots for DXBC, else non-comment lines).');
  return out.join('\n');
}

export function shader(c, idSpec) {
  const s = c.shaderById.get(Number.isNaN(Number(idSpec)) ? idSpec : Number(idSpec)) || c.shaderById.get(idSpec);
  if (!s) return `Shader ${idSpec} not found. Use \`shaders\` to list ids.`;
  const out = [];
  out.push(`SHADER ${s.id} (${s.stage}) ${s.name || ''}  entry=${s.entry}  encoding=${s.encoding}${s.compiler && s.compiler !== 'Unknown' ? '  compiler=' + s.compiler : ''}`);
  const cmd = (s.flags || []).find((f) => f[0] === '@cmdline');
  if (cmd) out.push(`compile flags: ${cmd[1] || '(none recorded)'}${isDebugCompiled(s) ? '   <- optimisation DISABLED: timings of draws using this shader are not representative' : ''}`);
  const st = shaderStats(c, s);
  out.push(`static: ${statsLabel(st) || 'n/a'}${st.hash ? `  disasm hash ${st.hash}` : ''}`);
  for (const [t, f] of Object.entries(s.disasm || {})) out.push(`disassembly (${t}): ${path.join(c.dir, 'shaders', f)}`);
  if (s.sourceDir) {
    out.push(`embedded source (${s.sourceFiles.length} files): ${path.join(c.dir, 'shaders', s.sourceDir)}`);
    out.push(...s.sourceFiles.slice(0, 8).map((f) => '  ' + f));
  } else {
    out.push('embedded source: none (compiled without debug info — see references/unity-shaders.md to enable it)');
  }
  if (s.cbuffers?.length) {
    out.push('constant buffers:');
    for (const cb of s.cbuffers) out.push(`  ${cb.name} (${cb.bytes} B): ${cb.vars.slice(0, 24).map((v) => v.name).join(', ')}${cb.vars.length > 24 ? ', …' : ''}`);
  }
  if (s.textures?.length) out.push(`textures: ${s.textures.map((t) => `${t.name}(${t.type})`).join(', ')}`);
  if (s.rw?.length) out.push(`uav: ${s.rw.map((t) => t.name).join(', ')}`);
  if (s.threadGroup) out.push(`thread group: ${s.threadGroup.join('x')}`);
  if (s.inputs?.length) out.push(`inputs: ${s.inputs.join(' ')}`);
  if (s.outputs?.length) out.push(`outputs: ${s.outputs.join(' ')}`);
  const users = shaderRanking(c, { stages: [s.stage] }).find((r) => r.id === s.id);
  if (users) {
    out.push(`used by ${users.uses} events, ${fmtMs(users.ms)} ms total; heaviest:`);
    const top = [...users.eids].sort((x, y) => (c.ms(y) || 0) - (c.ms(x) || 0)).slice(0, 8);
    out.push(table(['eid', 'ms', 'name', 'marker path'], top.map((e) => {
      const a = c.byEid.get(e);
      return [e, fmtMs(c.ms(e)), trunc(a.name, 40), pathStr(c, a, 70)];
    }), 'rrll'));
  }
  out.push(`NEXT  find-source <capture> ${s.id} --project <unity project> | source <capture> <eid> --stage ${s.stage} | experiment …`);
  return out.join('\n');
}

export function find(c, text) {
  const q = text.toLowerCase();
  const out = [];
  const acts = c.actions.filter((a) => a.name.toLowerCase().includes(q));
  if (acts.length) {
    const groups = new Map();
    for (const a of acts) {
      const g = groups.get(a.name) || { n: 0, eids: [], ms: 0 };
      g.n++; g.eids.push(a.eid);
      g.ms += (a.children > 0 ? c.nodeAgg(a).ms : c.ms(a.eid)) || 0;
      groups.set(a.name, g);
    }
    out.push(`events/markers (${acts.length}):`);
    out.push(table(['count', 'ms', 'first eids', 'name'], [...groups.entries()].sort((x, y) => y[1].ms - x[1].ms).slice(0, 15)
      .map(([n, g]) => [g.n, fmtMs(g.ms), g.eids.slice(0, 4).join(','), trunc(n, 80)]), 'rrll'));
  }
  const sh = c.shaders.filter((s) => (s.name || '').toLowerCase().includes(q) || s.entry.toLowerCase().includes(q)
    || (s.cbuffers || []).some((cb) => cb.name.toLowerCase().includes(q) || cb.vars.some((v) => v.name.toLowerCase().includes(q)))
    || (s.textures || []).some((t) => t.name.toLowerCase().includes(q)) || (s.sourceFiles || []).some((f) => f.toLowerCase().includes(q)));
  if (sh.length) {
    out.push(`shaders (${sh.length}) — name/entry/cbuffer/texture/source-file match:`);
    out.push(table(['id', 'stage', 'name', 'why'], sh.slice(0, 20).map((s) => {
      const why = [];
      if ((s.name || '').toLowerCase().includes(q)) why.push('name');
      for (const cb of s.cbuffers || []) for (const v of cb.vars) if (v.name.toLowerCase().includes(q)) why.push(v.name);
      for (const t of s.textures || []) if (t.name.toLowerCase().includes(q)) why.push('tex ' + t.name);
      return [s.id, s.stage, trunc(s.name || '', 40), trunc([...new Set(why)].join(', '), 60)];
    }), 'rlll'));
  }
  const tex = [...c.textures.values()].filter((t) => (t.name || '').toLowerCase().includes(q));
  if (tex.length) {
    out.push(`textures (${tex.length}):`);
    out.push(...tex.slice(0, 15).map((t) => '  ' + c.texLabel(t.id)));
  }
  return out.length ? out.join('\n') : `Nothing matches "${text}".`;
}

export function metrics(c, filter) {
  const out = [];
  const q = (filter || '').toLowerCase();
  const collected = c.metricKeys().filter((k) => !q || k.toLowerCase().includes(q));
  out.push(`COLLECTED (${collected.length}) — use these names with --by/--metrics:`);
  out.push(table(['metric', 'unit', 'aggregate', 'meaning'], collected.map((k) => {
    const cat = [...c.catalog.values()].find((x) => c.keyFor(x.name) === k);
    const help = GENERIC_HELP[k] || stripHtml(cat?.description).slice(0, 110);
    return [k, c.units[k], counterKind(k, c.units[k]) === 'wavg' ? 'weighted avg' : counterKind(k, c.units[k]), help];
  }), 'llll'));
  if (q) {
    const avail = [...c.catalog.values()].filter((x) => x.name.toLowerCase().includes(q) && !c.hasMetric(c.keyFor(x.name)));
    if (avail.length) {
      out.push('', `AVAILABLE, NOT FETCHED (${avail.length}) — \`fetch <capture> <name,name,...>\`:`);
      out.push(table(['name', 'unit', 'description'], avail.slice(0, 40).map((x) => [x.name, x.unit, stripHtml(x.description).slice(0, 110)]), 'lll'));
    }
  } else {
    out.push('', `catalog: ${c.catalog.size} counters enumerated by RenderDoc for this capture/GPU (filter: \`metrics <capture> <text>\`)`);
  }
  return out.join('\n');
}

export function readJsonFile(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export { bar };
