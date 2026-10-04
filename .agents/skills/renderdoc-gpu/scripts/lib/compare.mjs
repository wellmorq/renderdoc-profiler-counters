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

const WORK_METRICS = ['ps', 'verts', 'rastPrims', 'samples', 'cs', 'sm__inst_executed.sum', 'dram__bytes_op_read.sum', 'dram__bytes_op_write.sum'];

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
    if (Math.abs(wr - 1) < 0.03) { parts.push(`${shortMetric(m)} unchanged`); continue; }
    const costR = msR / wr;
    parts.push(`${shortMetric(m)} ${pct(wr)} (ms per ${shortMetric(m)} ${pct(costR)})`);
  }
  return parts.join('; ');
}

export function compare(A, B, marker, opts = {}) {
  const out = [];
  const fa = A.frameMs(); const fb = B.frameMs();
  out.push(`A ${A.meta.capture}: ${A.info.api} ${A.info.vendor}, ${fmtMs(fa)} ms, ${A.frameEvents().filter((e) => e.kind === 'draw').length} draws`);
  out.push(`B ${B.meta.capture}: ${B.info.api} ${B.info.vendor}, ${fmtMs(fb)} ms, ${B.frameEvents().filter((e) => e.kind === 'draw').length} draws`);
  out.push(`frame Δ ${fmtMs(fb - fa)} ms (${fmtDelta(fa, fb)})  [sum of per-event GPU durations in replay]`);
  const warn = [];
  if (A.info.api !== B.info.api) warn.push(`different API (${A.info.api} vs ${B.info.api})`);
  if (A.info.vendor !== B.info.vendor) warn.push(`replayed on different GPU vendors (${A.info.vendor} vs ${B.info.vendor})`);
  const ka = new Set(A.metricKeys()); const kb = new Set(B.metricKeys());
  const onlyA = [...ka].filter((k) => !kb.has(k)); const onlyB = [...kb].filter((k) => !ka.has(k));
  if (onlyA.length || onlyB.length) warn.push(`counter sets differ (only A: ${onlyA.slice(0, 4).join(', ') || '-'}; only B: ${onlyB.slice(0, 4).join(', ') || '-'})`);
  const mainTex = (c) => { const t = (c.info.textures || []).filter((x) => /RenderTarget|ColorTarget|SwapBuffer/i.test(x.flags || '')).sort((x, y) => (y.w * y.h) - (x.w * x.h))[0]; return t ? `${t.w}x${t.h}` : '?'; };
  if (mainTex(A) !== mainTex(B)) warn.push(`largest render target differs (${mainTex(A)} vs ${mainTex(B)}) — resolution change?`);
  for (const w of warn) out.push(`WARNING ${w}`);

  const rootsA = marker ? A.findNodes(marker) : A.roots;
  const rootsB = marker ? B.findNodes(marker) : B.roots;
  if (marker && (!rootsA.length || !rootsB.length)) return out.concat(`marker "${marker}" not found in ${!rootsA.length ? 'A' : 'B'}`).join('\n');
  if (marker && (rootsA.length > 1 || rootsB.length > 1)) out.push(`note: "${marker}" matches ${rootsA.length} node(s) in A and ${rootsB.length} in B; regions are compared as unions`);
  const metrics = (opts.metrics || WORK_METRICS).filter((m) => ka.has(m) && kb.has(m));

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
  const shown = rows.slice(0, opts.n || 20);
  const segs = (k) => k.split(SEP).slice(1);
  const first = shown.length ? segs(shown[0].k)[0] : null;
  const strip = first && shown.every((r) => segs(r.k)[0] === first) && shown.some((r) => segs(r.k).length > 1);
  const label = (k) => { const s = segs(k); return strip ? (s.length > 1 ? s.slice(1).join(' > ') : '(root) ' + s[0]) : s.join(' > '); };
  out.push('', `MARKERS by |Δms| (depth ≤${depth}${marker ? ` under "${marker}"` : ''}; matched by name path${strip ? `; paths relative to "${trunc(first, 70)}"` : ''})`);
  const mcols = metrics.filter((m) => ['ps', 'verts', 'cs', 'samples'].includes(m));
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
