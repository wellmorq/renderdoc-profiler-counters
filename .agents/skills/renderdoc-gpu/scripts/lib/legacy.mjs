// Import of RenderDoc UI exports (Event Browser "Export to TXT" + Performance Counter Viewer CSV)
// into a case, for captures you cannot replay here. No pipeline state or shaders in this mode.
import fs from 'node:fs';
import path from 'node:path';
import { CASE_VERSION } from './case.mjs';

function kindOf(name, hasRange) {
  if (/^(Draw|DrawIndexed|DrawInstanced|DrawIndexedInstanced|DrawAuto|DrawIndirect|DrawIndexedIndirect|glDraw|vkCmdDraw|DispatchMesh|ExecuteIndirect)/i.test(name)) return 'draw';
  if (/^(Dispatch|glDispatch|vkCmdDispatch)/i.test(name)) return 'dispatch';
  if (/^(Clear|glClear|vkCmdClear)/i.test(name)) return 'clear';
  if (/^(Copy|Resolve|Update(Sub)?resource|GenerateMips|glBlit|glCopy|vkCmdCopy|vkCmdBlit|vkCmdResolve)/i.test(name)) return 'copy';
  if (/^(Present|SwapBuffers|glXSwapBuffers|vkQueuePresent)/i.test(name)) return 'present';
  return hasRange ? 'marker' : 'marker';
}

export function parseEventsTxt(text) {
  const rows = [];
  const stack = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\|(.*)\|\s*([\d-]*)\s*$/);
    if (!m) continue;
    const eid = Number(m[1]);
    const col = m[2];
    const dash = col.search(/-\s/);
    if (dash < 0) continue;
    const depth = Math.max(0, Math.round((dash - 1) / 2));
    const name = col.slice(dash + 1).trim();
    const action = m[3];
    while (stack.length > depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : null;
    const isRange = action.includes('-');
    let kind = kindOf(name, isRange);
    if (kind === 'marker' && action && !isRange) kind = 'other';
    const row = { eid, parent: parent ? parent.eid : 0, depth, name, kind, flags: [], children: 0 };
    const idx = name.match(/^\w*Draw\w*\((\d+)(?:,\s*(\d+))?/);
    if (idx && kind === 'draw') { row.indices = Number(idx[1]); row.instances = idx[2] ? Number(idx[2]) : 1; }
    if (parent) parent.children++;
    rows.push(row);
    stack.push(row);
  }
  return rows;
}

function parseCsvLine(l) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCountersCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const cols = header.slice(1).map((h) => {
    const m = h.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const name = (m ? m[1] : h).trim();
    const u = m ? m[2].trim() : '';
    let unit = 'Absolute'; let scale = 1;
    if (u === 'ms') { unit = 'Seconds'; scale = 1e-3; } else if (u === 's') unit = 'Seconds';
    else if (u === 'us' || u === 'µs') { unit = 'Seconds'; scale = 1e-6; } else if (u === 'ns') { unit = 'Seconds'; scale = 1e-9; } else if (u === 'bytes') unit = 'Bytes';
    else if (u === '%') unit = 'Percentage';
    else if (/\.ratio$/.test(name)) unit = 'Ratio';
    return { name, unit, scale };
  });
  const data = [];
  for (const l of lines.slice(1)) {
    const f = parseCsvLine(l);
    const eid = Number(f[0]);
    if (!Number.isFinite(eid)) continue;
    data.push([eid, ...cols.map((c, i) => { const v = f[i + 1]; if (v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n * c.scale : null; })]);
  }
  return { cols, data };
}

export function importLegacy(dir, opts = {}) {
  const abs = path.resolve(dir);
  const files = fs.readdirSync(abs);
  const txts = files.filter((f) => /\.txt$/i.test(f)).sort();
  const csvs = files.filter((f) => /\.csv$/i.test(f)).sort();
  if (txts.length !== 1 || csvs.length !== 1) {
    throw new Error(`import expects exactly one .txt (Event Browser export) and one .csv (counters) in ${abs}; found ${txts.length} txt, ${csvs.length} csv. Put each before/after pair in its own folder.`);
  }
  const txt = path.join(abs, txts[0]);
  const csv = path.join(abs, csvs[0]);
  const out = path.resolve(opts.out || path.join(abs, path.basename(txt, '.txt') + '.rdgpu'));
  fs.mkdirSync(out, { recursive: true });
  const actions = parseEventsTxt(fs.readFileSync(txt, 'utf8'));
  for (const a of actions) { if (a.children > 0) a.lastEid = undefined; }
  fs.writeFileSync(path.join(out, 'actions.jsonl'), actions.map((a) => JSON.stringify(a)).join('\n') + '\n');
  const { cols, data } = parseCountersCsv(fs.readFileSync(csv, 'utf8'));
  fs.writeFileSync(path.join(out, 'counters-legacy.json'), JSON.stringify({ label: 'legacy-csv', counters: cols.map((c) => c.name), units: cols.map((c) => c.unit), missing: [], repeat: 1, data }));
  const head = fs.readFileSync(txt, 'utf8').split(/\r?\n/)[0];
  fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify({
    api: 'unknown (legacy export)', vendor: cols.some((c) => c.name.includes('__')) ? 'NVIDIA (from counter names)' : 'unknown',
    legacy: true, captureHeader: head,
    counters: cols.map((c) => ({ name: c.name, unit: c.unit, family: c.name.includes('__') ? 'nvidia' : 'generic', description: '' })),
    textures: [],
  }));
  fs.writeFileSync(path.join(out, 'case.json'), JSON.stringify({
    version: CASE_VERSION, capture: `${txt} + ${path.basename(csv)}`, legacy: true, created: new Date().toISOString(), host: 'import',
    options: { counters: ['legacy-csv'], state: false, shaders: false }, tasks: [],
  }, null, 1));
  return out;
}
