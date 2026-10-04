// Case = the cached extraction of one capture. Loading, metrics and aggregation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CASE_VERSION = 1;

// Generic RenderDoc counters by GPUCounter id -> short key.
export const GENERIC = {
  1: 'ms', 2: 'verts', 3: 'prims', 4: 'gsPrims', 5: 'rastInv', 6: 'rastPrims', 7: 'samples',
  8: 'vs', 9: 'hs', 10: 'ds', 11: 'gs', 12: 'ps', 13: 'cs', 14: 'as', 15: 'msInv',
};
export const GENERIC_HELP = {
  ms: 'GPU Duration (ms, timestamp-based)', verts: 'Input Vertices Read', prims: 'Input (IA) primitives',
  rastPrims: 'Rasterized primitives', rastInv: 'Rasterizer invocations', samples: 'Samples passed (depth/stencil test)',
  vs: 'VS invocations', ps: 'PS invocations (pixel shader threads)', cs: 'CS invocations (compute threads)',
  gs: 'GS invocations', hs: 'HS invocations', ds: 'DS invocations', gsPrims: 'GS output primitives',
};
const GENERIC_NAMES = {
  'GPU Duration': 'ms', 'Input Vertices Read': 'verts', 'Input Primitives': 'prims', 'IA Primitives': 'prims',
  'GS Primitives': 'gsPrims', 'Rasterizer Invocations': 'rastInv', 'Rasterized Primitives': 'rastPrims',
  'Samples Passed': 'samples', 'VS Invocations': 'vs', 'HS Invocations': 'hs', 'TCS Invocations': 'hs',
  'DS Invocations': 'ds', 'TES Invocations': 'ds', 'GS Invocations': 'gs', 'PS Invocations': 'ps',
  'FS Invocations': 'ps', 'CS Invocations': 'cs',
};

export const WORK_KINDS = new Set(['draw', 'dispatch', 'clear', 'copy']);

export function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

export function caseDirFor(target) {
  const abs = path.resolve(target);
  if (fs.existsSync(path.join(abs, 'case.json'))) return abs;
  if (/\.rdc$/i.test(abs)) {
    // Working cache derived from the .rdc (the .rdc stays the source of truth); kept out of the user's folders.
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    return path.join(cacheRoot(), path.basename(abs, path.extname(abs)) + '-' + sha1(key).slice(0, 10));
  }
  throw new Error(`Not a capture (.rdc) or prepared case directory: ${target}`);
}

export function cacheRoot() {
  if (process.env.RDGPU_CASES) return path.resolve(process.env.RDGPU_CASES);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'rdgpu', 'cache');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'rdgpu');
}

export function captureStamp(capture) {
  const st = fs.statSync(capture);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readJsonl = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

// Counter semantics for aggregation over many events.
export function counterKind(name, unit) {
  if (/\.max(\.|$)/.test(name)) return 'max';
  if (/\.min(\.|$)/.test(name)) return 'min';
  if (unit === 'Percentage' || unit === 'Ratio' || /\.(avg|pct|ratio)(\.|$)/.test(name)) return 'wavg';
  return 'sum';
}

export function isNanoCounter(name) {
  return /^gpu__time_(duration|active)\.(sum|avg|max|min)$/.test(name);
}

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

export class Case {
  constructor(dir) {
    this.dir = dir;
    this.meta = readJson(path.join(dir, 'case.json'), {});
    this.info = readJson(path.join(dir, 'info.json'), {});
    this.actions = readJsonl(path.join(dir, 'actions.jsonl'));
    this.byEid = new Map(this.actions.map((a) => [a.eid, a]));
    this.state = new Map(readJsonl(path.join(dir, 'state.jsonl')).map((s) => [s.eid, s]));
    this.resources = readJson(path.join(dir, 'resources.json'), {});
    this.shaders = readJson(path.join(dir, 'shaders.json'), []);
    this.shaderById = new Map();
    for (const s of this.shaders) {
      if (!this.shaderById.has(s.id)) this.shaderById.set(s.id, s);
      this.shaderById.set(s.key, s);
    }
    this.textures = new Map((this.info.textures || []).map((t) => [t.id, t]));
    this.catalog = new Map((this.info.counters || []).map((c) => [c.name, c]));
    this._loadCounters();
    this._buildTree();
  }

  _loadCounters() {
    this.values = new Map(); // eid -> {key: value}
    this.units = {}; // key -> unit
    this.counterSources = [];
    const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => /^counters-.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => a.t - b.t).map((x) => x.f) : [];
    this.spread = new Map(); // eid -> {key: [min,max]} from repeated runs
    for (const f of files) {
      const c = readJson(path.join(this.dir, f));
      if (!c || !c.counters) continue;
      this.counterSources.push({ file: f, label: c.label, counters: c.counters.length, missing: c.missing || [], repeat: c.repeat });
      for (const [eid, sp] of Object.entries(c.spread || {})) {
        const o = this.spread.get(Number(eid)) || {};
        for (const [n, mm] of Object.entries(sp)) o[this.keyFor(n)] = c.units?.[c.counters.indexOf(n)] === 'Seconds' ? mm.map((x) => x * 1000) : mm;
        this.spread.set(Number(eid), o);
      }
      const keys = c.counters.map((n) => this.keyFor(n));
      c.counters.forEach((n, i) => { this.units[keys[i]] = this.unitOf(n, c.units?.[i]); });
      for (const row of c.data) {
        const eid = row[0];
        let o = this.values.get(eid);
        if (!o) { o = {}; this.values.set(eid, o); }
        for (let i = 0; i < keys.length; i++) {
          let v = row[i + 1];
          if (v === null || v === undefined) continue;
          if (c.units?.[i] === 'Seconds') v *= 1000; // seconds -> ms
          o[keys[i]] = v;
        }
      }
    }
  }

  keyFor(name) {
    const cat = this.catalog.get(name);
    if (cat && cat.family === 'generic' && GENERIC[cat.id]) return GENERIC[cat.id];
    if (GENERIC_NAMES[name]) return GENERIC_NAMES[name];
    return name;
  }

  unitOf(name, unit) {
    if (unit === 'Seconds') return 'ms';
    if (isNanoCounter(name)) return 'ns';
    return unit || this.catalog.get(name)?.unit || 'Absolute';
  }

  metricKeys() { return Object.keys(this.units); }

  hasMetric(k) { return k in this.units; }

  // Resolve a user metric spec (alias, exact counter name, case-insensitive, or unique substring).
  resolveMetric(spec) {
    if (!spec) return null;
    if (this.hasMetric(spec)) return spec;
    const keys = this.metricKeys();
    const lower = spec.toLowerCase();
    const exact = keys.find((k) => k.toLowerCase() === lower) || keys.find((k) => shortMetric(k).toLowerCase() === lower);
    if (exact) return exact;
    const alias = { duration: 'ms', time: 'ms', 'gpu duration': 'ms', pixels: 'ps', vertices: 'verts' }[lower];
    if (alias && this.hasMetric(alias)) return alias;
    const subs = keys.filter((k) => k.toLowerCase().includes(lower));
    if (subs.length === 1) return subs[0];
    if (subs.length > 1) throw new Error(`Metric "${spec}" is ambiguous: ${subs.slice(0, 8).join(', ')}${subs.length > 8 ? ', …' : ''}`);
    throw new Error(`Metric "${spec}" was not collected. Collected (short names work too): ${keys.map(shortMetric).slice(0, 30).join(', ')}${keys.length > 30 ? ', …' : ''}. Groups: @work @memory @stalls @inst. Use \`metrics <rdc> <text>\` / \`fetch\` for others.`);
  }

  // Expand a --metrics list: names, short names, or groups (@work, @memory, @stalls, @inst).
  expandMetrics(list, events = null) {
    const out = [];
    const add = (k) => { if (k && !out.includes(k)) out.push(k); };
    for (const raw of list) {
      const m = String(raw).trim();
      if (!m) continue;
      if (m === '@work') { for (const k of ['ps', 'verts', 'rastPrims', 'samples', 'cs']) if (this.hasMetric(k)) add(k); continue; }
      if (m === '@memory') { for (const k of this.metricKeys().filter((k) => /^(dram__bytes_op_(read|write)\.sum|l1tex__t_sector_hit_rate\.avg\.pct|lts__t_sector_hit_rate\.avg\.pct)$/.test(k))) add(k); continue; }
      if (m === '@inst') { for (const k of this.metricKeys().filter((k) => /^(sm__inst_executed\.sum|smsp__inst_executed_shader_\w+\.sum)$/.test(k))) add(k); continue; }
      if (m === '@stalls') {
        const st = this.metricKeys().filter((k) => /^smsp__warp_issue_stalled_.*_per_warp_active\.avg\.pct$/.test(k) && !/_(not_selected|selected)_/.test(k));
        const evs = events || this.frameEvents();
        const ag = this.aggregate(evs, st);
        st.sort((a, b) => (ag[b].v || 0) - (ag[a].v || 0)).slice(0, 3).forEach(add);
        continue;
      }
      add(this.resolveMetric(m));
    }
    return out;
  }

  timeKey() {
    if (this.hasMetric('ms')) return 'ms';
    if (this.hasMetric('gpu__time_duration.sum')) return 'gpu__time_duration.sum';
    return null;
  }

  // GPU time of a single event in ms (null when not measured).
  ms(eid) {
    const v = this.values.get(eid);
    if (!v) return null;
    if (v.ms !== undefined) return v.ms;
    if (v['gpu__time_duration.sum'] !== undefined) return v['gpu__time_duration.sum'] / 1e6;
    return null;
  }

  get(eid, key) {
    const v = this.values.get(eid);
    return v ? v[key] : undefined;
  }

  _buildTree() {
    this.children = new Map();
    this.roots = [];
    for (const a of this.actions) {
      if (a.parent && this.byEid.has(a.parent)) {
        if (!this.children.has(a.parent)) this.children.set(a.parent, []);
        this.children.get(a.parent).push(a);
      } else {
        this.roots.push(a);
      }
    }
    this._agg = new Map();
  }

  kids(a) { return this.children.get(a.eid) || []; }

  // All work events (draw/dispatch/clear/copy) under a node, inclusive.
  workUnder(a, out = []) {
    if (WORK_KINDS.has(a.kind)) out.push(a);
    for (const c of this.kids(a)) this.workUnder(c, out);
    return out;
  }

  pathOf(a) {
    const names = [];
    let cur = a;
    while (cur) {
      names.unshift(cur.name);
      cur = cur.parent ? this.byEid.get(cur.parent) : null;
    }
    return names;
  }

  markerPathOf(a) {
    const p = this.pathOf(a);
    return p.slice(0, -1);
  }

  // Largest colour render target used by any draw (≈ screen/back-buffer resolution).
  screenPixels() {
    let best = 0;
    for (const st of this.state.values()) for (const r of st.rts || []) {
      const t = this.textures.get(r) || this.resources[String(r)];
      if (t && t.w && t.h) best = Math.max(best, t.w * t.h);
    }
    return best || null;
  }

  frameEvents() { return this.actions.filter((a) => WORK_KINDS.has(a.kind)); }

  frameMs() {
    let s = 0;
    let n = 0;
    for (const a of this.frameEvents()) {
      const m = this.ms(a.eid);
      if (m !== null) { s += m; n++; }
    }
    return n ? s : null;
  }

  // Aggregate a set of events. Returns {key: {v, how}}; wavg is duration-weighted.
  aggregate(events, keys = this.metricKeys()) {
    const res = {};
    const measured = events.filter((e) => this.values.has(e.eid));
    for (const k of keys) {
      const kind = counterKind(k, this.units[k]);
      let v = null;
      if (kind === 'sum') {
        let s = 0; let any = false;
        for (const e of measured) { const x = this.get(e.eid, k); if (x !== undefined) { s += x; any = true; } }
        v = any ? s : (measured.length ? 0 : null);
      } else if (kind === 'max' || kind === 'min') {
        for (const e of measured) {
          const x = this.get(e.eid, k);
          if (x === undefined) continue;
          v = v === null ? x : (kind === 'max' ? Math.max(v, x) : Math.min(v, x));
        }
      } else {
        let s = 0; let w = 0;
        for (const e of measured) {
          const x = this.get(e.eid, k);
          const d = this.ms(e.eid);
          if (x === undefined || !d) continue;
          s += x * d; w += d;
        }
        v = w > 0 ? s / w : null;
      }
      res[k] = { v, how: kind };
    }
    res._count = { draws: events.filter((e) => e.kind === 'draw').length, dispatches: events.filter((e) => e.kind === 'dispatch').length, measured: measured.length, events: events.length };
    return res;
  }

  nodeAgg(a) {
    if (this._agg.has(a.eid)) return this._agg.get(a.eid);
    const evs = this.workUnder(a);
    let ms = 0; let any = false;
    for (const e of evs) { const m = this.ms(e.eid); if (m !== null) { ms += m; any = true; } }
    const r = { ms: any ? ms : null, draws: evs.filter((e) => e.kind === 'draw').length, dispatches: evs.filter((e) => e.kind === 'dispatch').length, events: evs };
    this._agg.set(a.eid, r);
    return r;
  }

  // Marker/event lookup by name substring, exact path ("A > B"), or EID.
  findNodes(query) {
    if (query === undefined || query === null || query === '.' || query === '*') return this.roots;
    if (/^\d+$/.test(String(query))) {
      const a = this.byEid.get(Number(query));
      return a ? [a] : [];
    }
    const q = String(query).toLowerCase();
    if (q.includes(' > ')) {
      const parts = q.split(' > ').map((s) => s.trim());
      return this.actions.filter((a) => {
        const p = this.pathOf(a).map((s) => s.toLowerCase());
        if (p.length < parts.length) return false;
        const tail = p.slice(p.length - parts.length);
        return tail.every((s, i) => s.includes(parts[i]));
      });
    }
    let hits = this.actions.filter((a) => a.name.toLowerCase() === q && (a.children || a.kind === 'marker'));
    if (!hits.length) hits = this.actions.filter((a) => a.name.toLowerCase().includes(q) && (a.children > 0 || a.kind === 'marker'));
    if (!hits.length) hits = this.actions.filter((a) => a.name.toLowerCase().includes(q));
    // drop matches nested inside another match
    const set = new Set(hits.map((h) => h.eid));
    return hits.filter((h) => {
      let p = h.parent ? this.byEid.get(h.parent) : null;
      while (p) { if (set.has(p.eid)) return false; p = p.parent ? this.byEid.get(p.parent) : null; }
      return true;
    });
  }

  shaderOf(eid, stage) {
    const st = this.state.get(eid);
    return st && st.shaders ? st.shaders[stage] : undefined;
  }

  shaderLabel(id) {
    const s = this.shaderById.get(id);
    if (!s) return String(id);
    const nm = s.name && !/^(Shader|Pixel Shader|Vertex Shader|Compute Shader)\s*\d+$/i.test(s.name) ? s.name : '';
    return nm ? `${id} ${nm}` : `${id}`;
  }

  texLabel(id) {
    const t = this.textures.get(id) || this.resources[String(id)];
    if (!t) return String(id);
    const size = t.w ? `${t.w}x${t.h}${t.d > 1 ? 'x' + t.d : ''}` : '';
    return `${id}${t.name ? ' ' + t.name : ''}${size ? ' ' + size : ''}${t.fmt ? ' ' + t.fmt : ''}`;
  }
}

export function loadCase(target) {
  const dir = caseDirFor(target);
  if (!fs.existsSync(path.join(dir, 'case.json'))) {
    throw new Error(`No prepared case at ${dir}. Run: open ${target}`);
  }
  return new Case(dir);
}
