// Before/after comparison of two prepared cases.
import { WORK_KINDS } from './case.mjs';
import { fmtDelta, fmtMs, fmtNum, table, trunc } from './format.mjs';
import { shaderRanking, shortMetric } from './query.mjs';
import { shaderStats, statsLabel } from './shaderstats.mjs';

const SEP = '\u0001';

function keyedMarkers(c, roots) {
  const map = new Map();
  const visit = (nodes, parentKey, depth) => {
    const seen = new Map();
    for (const a of nodes) {
      if (!(a.children > 0)) continue;
      const k = seen.get(a.name) || 0;
      seen.set(a.name, k + 1);
      const key = `${parentKey}${SEP}${a.name}${k ? '#' + k : ''}`;
      map.set(key, { a, depth, key });
      visit(c.kids(a), key, depth + 1);
    }
  };
  visit(roots, '', 0);
  return map;
}

const WORK_METRICS = ['ps', 'verts', 'rastPrims', 'samples', 'cs', 'ropBytes', 'vtxBytes', 'sm__inst_executed.sum', 'dram__bytes_op_read.sum', 'dram__bytes_op_write.sum'];

function regionStats(c, evs, metrics) {
  const ag = c.aggregate(evs, metrics);
  let ms = 0; let any = false;
  for (const e of evs) { const m = c.ms(e.eid); if (m !== null) { ms += m; any = true; } }
  return { ms: any ? ms : null, draws: evs.filter((e) => e.kind === 'draw').length, dispatches: evs.filter((e) => e.kind === 'dispatch').length, ag };
}

function explain(name, A, B, metrics) {
  const parts = [];
  const r = (x, y) => (x ? y / x : null);
  const pct = (v) => `${v >= 1 ? '+' : ''}${((v - 1) * 100).toFixed(0)}%`;
  const msR = r(A.ms, B.ms);
  if (msR === null) return null;
  parts.push(`${name}: ${fmtMs(A.ms)} → ${fmtMs(B.ms)} ms (${pct(msR)})`);
  if (A.draws !== B.draws || A.dispatches !== B.dispatches) parts.push(`draws ${A.draws}→${B.draws}, dispatches ${A.dispatches}→${B.dispatches}`);
  for (const m of metrics) {
    const a = A.ag[m]?.v; const b = B.ag[m]?.v;
    if (!a || b === null || b === undefined) continue;
    const wr = b / a;
    if (Math.abs(wr - 1) < 0.03) { parts.push(`${shortMetric(m)} same`); continue; }
    const costR = msR / wr;
    parts.push(`${shortMetric(m)} ${pct(wr)} (ms per ${shortMetric(m)} ${pct(costR)})`);
  }
  return parts.join('; ');
}

// One-line answer to "slower or faster, and is it the same work?" for a region (or the frame).
function verdict(label, A, B, metrics, noise) {
  if (!A.ms || B.ms === null) return null;
  const dms = B.ms / A.ms - 1;
  const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
  const grew = []; const shrank = [];
  for (const m of metrics) {
    const a = A.ag[m]?.v; const b = B.ag[m]?.v;
    if (!a || b === null || b === undefined) continue;
    const r = b / a - 1;
    if (r > 0.1) grew.push(`${shortMetric(m)} ${pct(r)}`);
    else if (r < -0.1) shrank.push(`${shortMetric(m)} ${pct(r)}`);
  }
  const inNoise = noise !== null && Math.abs(dms * 100) <= noise;
  const t = `${fmtMs(A.ms)} → ${fmtMs(B.ms)} ms (${pct(dms)}${inNoise ? ', within noise' : ''})`;
  const g = grew.length ? `more work: ${grew.join(', ')}` : '';
  const sh = shrank.length ? `less work: ${shrank.join(', ')}` : '';
  const draws = A.draws !== B.draws ? `draws ${A.draws}→${B.draws}` : '';
  const facts = [draws, g, sh].filter(Boolean).join('; ') || 'same work';
  let read;
  if (inNoise) read = grew.length ? 'time unchanged within noise but work grew — may show up on a real GPU' : 'no measurable change';
  else if (dms < 0 && grew.length) read = 'FASTER in this replay but HEAVIER in work: the win comes from cheaper per-item cost (shader); the extra work (especially ropBytes = output bandwidth) can eat it on a real GPU — report both';
  else if (dms < 0 && (shrank.length || draws)) read = 'faster, with less or restructured work';
  else if (dms < 0) read = 'faster with the same work: per-item cost dropped (constants/loops, textures, shader code) or replay noise → drawdiff';
  else if (grew.length) read = 'SLOWER and more work: compare which work metric grew in proportion to time (ropBytes → formats/blending, ps → pixels/overdraw, verts → geometry)';
  else read = 'SLOWER with the same work: per-item cost grew (constants/loops, textures, shader code) → drawdiff';
  return `VERDICT ${label}: ${t}; ${facts} → ${read}`;
}

// Markers whose work counters did not change still move between replays; their spread is the noise floor.
function noiseFloor(rows, metrics, frame) {
  const same = rows.filter((r) => r.sa && r.sb && r.sa.ms && r.sa.draws === r.sb.draws && r.sa.ms >= frame * 0.01
    && metrics.every((m) => { const a = r.sa.ag[m]?.v; const b = r.sb.ag[m]?.v; return !a || (b !== null && b !== undefined && Math.abs(b / a - 1) < 0.03); }));
  if (same.length < 2) return null;
  const d = same.map((r) => (r.sb.ms / r.sa.ms - 1) * 100).sort((x, y) => x - y);
  // time-weighted median of |Δ|: big markers are measured more reliably than tiny ones
  const w = same.map((r) => ({ v: Math.abs((r.sb.ms / r.sa.ms - 1) * 100), w: r.sa.ms })).sort((x, y) => x.v - y.v);
  const tot = w.reduce((s2, x) => s2 + x.w, 0);
  let acc = 0; let med = w[w.length - 1].v;
  for (const x of w) { acc += x.w; if (acc >= tot / 2) { med = x.v; break; } }
  const oneWay = d.every((v) => v < -3) || d.every((v) => v > 3);
  return { n: same.length, med, min: d[0], max: d[d.length - 1], oneWay, limit: Math.max(5, med * 1.25) };
}

export function compare(A, B, marker, opts = {}) {
  const out = [];
  const fa = A.frameMs(); const fb = B.frameMs();
  out.push(`A ${A.meta.capture}: ${A.info.api} ${A.info.vendor}, ${fmtMs(fa)} ms, ${A.frameEvents().filter((e) => e.kind === 'draw').length} draws`);
  out.push(`B ${B.meta.capture}: ${B.info.api} ${B.info.vendor}, ${fmtMs(fb)} ms, ${B.frameEvents().filter((e) => e.kind === 'draw').length} draws`);
  out.push(`frame Δ ${fmtMs(fb - fa)} ms (${fmtDelta(fa, fb)})  [sum of per-event GPU durations in replay]`);
  const ka = new Set(A.metricKeys()); const kb = new Set(B.metricKeys());
  const metrics = (opts.metrics || WORK_METRICS).filter((m) => ka.has(m) && kb.has(m));
  const workOf = (c) => c.frameEvents().filter((e) => WORK_KINDS.has(e.kind));
  const frA = regionStats(A, workOf(A), metrics); const frB = regionStats(B, workOf(B), metrics);
  const fw = metrics.filter((m) => ['ps', 'verts', 'samples', 'cs', 'ropBytes', 'vtxBytes'].includes(m) && frA.ag[m]?.v)
    .map((m) => `${shortMetric(m)} ${fmtDelta(frA.ag[m].v, frB.ag[m].v)}`);
  if (fw.length) out.push(`frame work Δ: ${fw.join(', ')}`);
  const warn = [];
  if (A.info.api !== B.info.api) warn.push(`different API (${A.info.api} vs ${B.info.api})`);
  if (A.info.vendor !== B.info.vendor) warn.push(`replayed on different GPU vendors (${A.info.vendor} vs ${B.info.vendor})`);
  const onlyA = [...ka].filter((k) => !kb.has(k)); const onlyB = [...kb].filter((k) => !ka.has(k));
  if (onlyA.length || onlyB.length) warn.push(`counter sets differ (only A: ${onlyA.slice(0, 4).join(', ') || '-'}; only B: ${onlyB.slice(0, 4).join(', ') || '-'})`);
  const mainTex = (c) => { const t = (c.info.textures || []).filter((x) => /RenderTarget|ColorTarget|SwapBuffer/i.test(x.flags || '')).sort((x, y) => (y.w * y.h) - (x.w * x.h))[0]; return t ? `${t.w}x${t.h}` : '?'; };
  if (mainTex(A) !== mainTex(B)) warn.push(`largest render target differs (${mainTex(A)} vs ${mainTex(B)}) — resolution change?`);
  if ([A, B].some((c) => /software|llvmpipe|warp/i.test(c.info.vendor || '') || c.info.degraded)) warn.push('replayed on a software/degraded GPU: per-marker timing swings without a work or drawdiff difference are noise');
  for (const w of warn) out.push(`WARNING ${w}`);

  const rootsA = marker ? A.findNodes(marker) : A.roots;
  const rootsB = marker ? B.findNodes(marker) : B.roots;
  if (marker && (!rootsA.length || !rootsB.length)) return out.concat(`marker "${marker}" not found in ${!rootsA.length ? 'A' : 'B'}`).join('\n');
  if (marker && (rootsA.length > 1 || rootsB.length > 1)) out.push(`note: "${marker}" matches ${rootsA.length} node(s) in A and ${rootsB.length} in B; regions are compared as unions`);
  let regionVerdict = null;
  if (marker) {
    const ra = regionStats(A, rootsA.flatMap((n) => A.workUnder(n)), metrics);
    const rb = regionStats(B, rootsB.flatMap((n) => B.workUnder(n)), metrics);
    out.push('', 'REGION');
    out.push(table(['metric', 'A', 'B', 'Δ'], [
      ['ms', fmtMs(ra.ms), fmtMs(rb.ms), fmtDelta(ra.ms, rb.ms)],
      ['draws', ra.draws, rb.draws, fmtDelta(ra.draws, rb.draws)],
      ['dispatches', ra.dispatches, rb.dispatches, fmtDelta(ra.dispatches, rb.dispatches)],
      ...metrics.map((m) => [shortMetric(m), fmtNum(ra.ag[m].v), fmtNum(rb.ag[m].v), fmtDelta(ra.ag[m].v, rb.ag[m].v)]),
    ], 'lrrr'));
    const e = explain(marker, ra, rb, metrics);
    if (e) out.push('reading: ' + e);
    regionVerdict = { label: `"${marker}"`, ra, rb };
  }

  const ma = keyedMarkers(A, rootsA.flatMap((n) => (marker ? A.kids(n) : [n])));
  const mb = keyedMarkers(B, rootsB.flatMap((n) => (marker ? B.kids(n) : [n])));
  const depth = opts.depth ?? 2;
  const rows = [];
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  for (const k of keys) {
    const x = ma.get(k); const y = mb.get(k);
    const d = (x || y).depth;
    if (d > depth) continue;
    const sa = x ? regionStats(A, A.workUnder(x.a), metrics) : null;
    const sb = y ? regionStats(B, B.workUnder(y.a), metrics) : null;
    rows.push({ k, d, x, y, sa, sb, delta: (sb?.ms || 0) - (sa?.ms || 0) });
  }
  rows.sort((p, r) => Math.abs(r.delta) - Math.abs(p.delta));
  const noise = noiseFloor(rows, metrics, fa || 0);
  const verdicts = [];
  if (regionVerdict) verdicts.push(verdict(regionVerdict.label, regionVerdict.ra, regionVerdict.rb, metrics, noise?.limit ?? null));
  else {
    verdicts.push(verdict('frame', frA, frB, metrics, noise?.limit ?? null));
    const workChanged = (r) => r.sa.draws !== r.sb.draws || metrics.some((m) => { const a = r.sa.ag[m]?.v; const b = r.sb.ag[m]?.v; return a && b && Math.abs(b / a - 1) > 0.1; });
    const interesting = rows.filter((x) => x.d > 0 && x.sa && x.sb && x.sa.ms >= (fa || 0) * 0.02
      && (workChanged(x) || !noise || Math.abs((x.sb.ms / x.sa.ms - 1) * 100) > noise.limit));
    interesting.sort((p, q) => Number(workChanged(q)) - Number(workChanged(p)));
    for (const r of interesting.slice(0, 3)) {
      verdicts.push(verdict(`"${trunc(r.k.split(SEP).pop(), 40)}"`, r.sa, r.sb, metrics, noise?.limit ?? null));
    }
  }
  const vl = verdicts.filter(Boolean);
  if (vl.length) out.push('', ...vl);
  if (noise) {
    out.push(`NOISE   ${noise.n} markers with unchanged work moved ${noise.min.toFixed(0)}%..${noise.max >= 0 ? '+' : ''}${noise.max.toFixed(0)}% (typical |Δ| ${noise.med.toFixed(0)}%, time-weighted)`
      + `${noise.oneWay ? ' all in one direction → a global shift between replays (load/clocks): compare shares of the frame, not raw ms' : ''}; treat |Δ| ≤ ${noise.limit.toFixed(0)}% on other markers as noise unless work changed`);
  }
  const shown = rows.slice(0, opts.n || 20);
  const segs = (k) => k.split(SEP).slice(1);
  const first = shown.length ? segs(shown[0].k)[0] : null;
  const strip = first && shown.every((r) => segs(r.k)[0] === first) && shown.some((r) => segs(r.k).length > 1);
  const label = (k) => { const s = segs(k); return strip ? (s.length > 1 ? s.slice(1).join(' > ') : '(root) ' + s[0]) : s.join(' > '); };
  out.push('', `MARKERS by |Δms| (depth ≤${depth}${marker ? ` under "${marker}"` : ''}; matched by name path${strip ? `; paths relative to "${trunc(first, 70)}"` : ''})`);
  const mcols = metrics.filter((m) => ['ps', 'verts', 'cs', 'samples', 'ropBytes', 'vtxBytes'].includes(m));
  out.push(table(['A ms', 'B ms', 'Δms', 'Δ%', 'draws', ...mcols.map((m) => `Δ${m}`), 'marker'], shown.map((r) => [
    fmtMs(r.sa?.ms), fmtMs(r.sb?.ms), (r.delta >= 0 ? '+' : '') + fmtMs(r.delta), r.sa && r.sb ? fmtDelta(r.sa.ms, r.sb.ms) : (r.sa ? 'gone' : 'new'),
    `${r.sa?.draws ?? '-'}→${r.sb?.draws ?? '-'}`, ...mcols.map((m) => (r.sa && r.sb ? fmtDelta(r.sa.ag[m].v, r.sb.ag[m].v) : '')),
    trunc(label(r.k), 90),
  ]), 'rrrrr' + 'r'.repeat(mcols.length) + 'l'));
  const gone = rows.filter((r) => !r.y).length; const added = rows.filter((r) => !r.x).length;
  if (gone || added) out.push(`topology: ${gone} marker(s) only in A, ${added} only in B — aggregates of parents cover different event sets`);
  const expl = shown.filter((r) => r.sa && r.sb && r.d === Math.min(...shown.map((s) => s.d)) + (marker ? 0 : 1)).slice(0, 4)
    .map((r) => explain(segs(r.k).pop(), r.sa, r.sb, metrics)).filter(Boolean);
  if (expl.length) out.push('', 'WORK vs COST (top changed markers):', ...expl.map((e) => '  ' + e));
  // same work but different cost -> the per-item cost changed: point at the heaviest event to diff
  const hints = [];
  for (const r of shown.filter((x) => x.sa && x.sb && x.sa.ms && Math.abs(x.delta) / x.sa.ms > 0.1)) {
    const same = metrics.every((m) => { const a = r.sa.ag[m]?.v; const b = r.sb.ag[m]?.v; return !a || (b !== null && Math.abs(b / a - 1) < 0.03); });
    if (!same) continue;
    const evB = B.workUnder(r.y.a).filter((e) => e.kind === 'draw' || e.kind === 'dispatch').sort((p, q) => (B.ms(q.eid) || 0) - (B.ms(p.eid) || 0))[0];
    const evA = evB && A.workUnder(r.x.a).find((e) => e.name === evB.name && e.eid === evB.eid) ? evB.eid : null;
    if (evB && !hints.some((h) => h.includes(`@${evB.eid}`))) hints.push(`  ${trunc(r.k.split(SEP).pop(), 50)}: same work, ${fmtDelta(r.sa.ms, r.sb.ms)} time -> drawdiff <A> <B> ${evA ?? `<eid in A> ${evB.eid}`}   (heaviest event @${evB.eid})`);
    if (hints.length >= 4) break;
  }
  if (hints.length) out.push('', 'SAME WORK COUNTERS, DIFFERENT COST — per-item cost changed (constants such as loop counts, textures, state) or timing noise. Check the heaviest event (live):', ...hints,
    '  drawdiff shows nothing -> shader code (SHADERS table) or noise; confirm with `fetch <rdc> generic --repeat 5` on both.');

  // state/format changes inside the regions that moved most: render targets, blending, vertex layout, textures
  const prof = (c, node) => {
    const p = { rt: new Map(), fmt: new Map(), vb: new Map(), tex: new Map(), draws: 0 };
    const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const e of c.workUnder(node)) {
      if (e.kind !== 'draw' && e.kind !== 'dispatch') continue;
      p.draws++;
      const st = c.state.get(e.eid);
      if (!st) continue;
      (st.rts || []).forEach((r, i) => {
        const t = c.textures.get(r) || c.resources[String(r)] || {};
        const bl = (st.blend?.[i] ?? st.blend?.[0]) ? ' blended' : '';
        inc(p.rt, `${t.fmt || '?'} ${t.w || '?'}x${t.h || '?'}${bl}${t.ms > 1 ? ` ${t.ms}xMSAA` : ''}`);
        inc(p.fmt, `${t.fmt || '?'}${t.bpp ? ` (${t.bpp / 8} B/px)` : ''}${bl}`);
      });
      if (st.vertexBytes) inc(p.vb, `${st.vertexBytes} B/vertex`);
      for (const r of st.srv?.ps || st.srv?.cs || []) {
        const t = c.textures.get(r) || c.resources[String(r)];
        if (t?.fmt) inc(p.tex, `${t.name ? t.name + ' ' : ''}${t.fmt} ${t.w}x${t.h}`);
      }
    }
    return p;
  };
  const fmtMap = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', ') || '-';
  const sameMap = (x, y) => x.size === y.size && [...x].every(([k, n]) => y.get(k) === n);
  const stateLines = [];
  for (const r of rows.filter((x) => x.x && x.y && x.d >= (marker ? 0 : 1)).slice(0, 8)) {
    const pa = prof(A, r.x.a); const pb = prof(B, r.y.a);
    const diffs = [];
    if (pa.draws !== pb.draws) diffs.push(`draws ${pa.draws} → ${pb.draws}`);
    const delta = (label, x, y) => {
      if (sameMap(x, y)) return;
      const minus = new Map(); const plus = new Map();
      for (const [k, n] of x) { const d = n - (y.get(k) || 0); if (d > 0) minus.set(k, d); }
      for (const [k, n] of y) { const d = n - (x.get(k) || 0); if (d > 0) plus.set(k, d); }
      diffs.push(`${label}: ${minus.size ? `− ${fmtMap(minus)}` : ''}${minus.size && plus.size ? '  ' : ''}${plus.size ? `+ ${fmtMap(plus)}` : ''}`);
    };
    if (!sameMap(pa.fmt, pb.fmt)) diffs.push(`output formats (draw count): ${fmtMap(pa.fmt)}  →  ${fmtMap(pb.fmt)}`);
    delta('render targets', pa.rt, pb.rt);
    delta('vertex size', pa.vb, pb.vb);
    delta('textures read', pa.tex, pb.tex);
    if (diffs.length) stateLines.push(`  ${trunc(segs(r.k).join(' > '), 70)} (${fmtMs(r.sa.ms)} → ${fmtMs(r.sb.ms)} ms):`, ...diffs.map((d) => `    ${trunc(d, 400)}`));
  }
  if (stateLines.length) out.push('', 'STATE / FORMAT CHANGES in changed regions (formats, blending, vertex layout, sampled textures):', ...stateLines,
    '  Format/blend changes alter bytes per pixel → compare ropBytes (estimated ROP traffic) in the marker table and `event` on the heaviest draw.');

  // shaders
  const shA = shaderRanking(A, { stages: ['ps', 'cs', 'vs'], within: marker ? rootsA.flatMap((n) => A.workUnder(n)) : null });
  const shB = shaderRanking(B, { stages: ['ps', 'cs', 'vs'], within: marker ? rootsB.flatMap((n) => B.workUnder(n)) : null });
  if (shA.length && shB.length) {
    const keyOf = (c, r) => {
      const s = c.shaderById.get(r.id) || {};
      const st = shaderStats(c, s);
      const named = s.name && !/^(Shader|Pixel Shader|Vertex Shader|Compute Shader)\s*\d+$/i.test(s.name);
      const sig = [r.stage, s.entry, ...(s.cbuffers || []).map((x) => x.name), ...(s.textures || []).map((x) => x.name)].join('|');
      return { name: named ? `${r.stage}|${s.name}` : null, hash: st.hash ? `${r.stage}|${st.hash}` : null, sig, st, s };
    };
    const ia = shA.map((r) => ({ r, k: keyOf(A, r) }));
    const ib = shB.map((r) => ({ r, k: keyOf(B, r) }));
    const used = new Set();
    const pairs = [];
    const sigCount = (arr, sig) => arr.filter((z) => z.k.sig === sig).length;
    const score = (x, y) => {
      if (x.r.stage !== y.r.stage) return 0;
      let sc = 0;
      if (x.k.name && x.k.name === y.k.name) sc += 8;
      if (x.k.hash && x.k.hash === y.k.hash) sc += 4;
      if (x.k.sig === y.k.sig) sc += sigCount(ia, x.k.sig) === 1 && sigCount(ib, y.k.sig) === 1 ? 3 : 1;
      if (x.r.id === y.r.id) sc += 0.5;
      return sc >= 1 ? sc : 0;
    };
    const cand = [];
    for (const x of ia) for (const y of ib) { const sc = score(x, y); if (sc) cand.push({ x, y, sc }); }
    cand.sort((p, q) => q.sc - p.sc);
    const usedA = new Set();
    for (const { x, y } of cand) {
      if (usedA.has(x) || used.has(y)) continue;
      usedA.add(x); used.add(y);
      pairs.push({ x, y });
    }
    for (const x of ia) if (!usedA.has(x)) pairs.push({ x, y: null });
    for (const y of ib) if (!used.has(y)) pairs.push({ x: null, y });
    pairs.sort((p, r) => Math.abs((r.y?.r.ms || 0) - (r.x?.r.ms || 0)) - Math.abs((p.y?.r.ms || 0) - (p.x?.r.ms || 0)));
    out.push('', 'SHADERS by |Δms| (matched by name, else identical disassembly, else unique reflection signature)');
    out.push(table(['stage', 'A ms', 'B ms', 'Δms', 'uses', 'code', 'static A → B', 'ids', 'name'], pairs.slice(0, opts.n || 12).map(({ x, y }) => {
      const code = x && y ? (x.k.st.hash && y.k.st.hash ? (x.k.st.hash === y.k.st.hash ? 'same' : 'CHANGED') : '?') : (x ? 'gone' : 'new');
      return [(x || y).r.stage, fmtMs(x?.r.ms), fmtMs(y?.r.ms), fmtMs((y?.r.ms || 0) - (x?.r.ms || 0)), `${x?.r.uses ?? '-'}→${y?.r.uses ?? '-'}`, code,
        `${statsLabel(x?.k.st) || '-'} → ${statsLabel(y?.k.st) || '-'}`, `${x?.r.id ?? '-'}/${y?.r.id ?? '-'}`, trunc((x || y).k.s.name || '', 36)];
    }), 'lrrrrllll'));
    out.push('Shader ms attributes the whole draw to each of its stages; compare the same stage only.');
  }
  return out.join('\n');
}

export { WORK_KINDS };
