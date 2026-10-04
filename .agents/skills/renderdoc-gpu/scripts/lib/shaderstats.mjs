// Static, text-level statistics from shader disassembly. Approximate by design.
import fs from 'node:fs';
import path from 'node:path';
import { sha1 } from './case.mjs';

const cache = new Map();

export function shaderStats(c, s) {
  const key = `${c.dir}|${s.key}`;
  if (cache.has(key)) return cache.get(key);
  const out = { lines: 0 };
  const file = Object.values(s.disasm || {})[0];
  if (file) {
    let text = '';
    try { text = fs.readFileSync(path.join(c.dir, 'shaders', file), 'utf8'); } catch { /* missing */ }
    out.hash = sha1(text).slice(0, 12);
    const body = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(\/\/|;|#)/.test(l));
    out.lines = body.length;
    let m = text.match(/Approximately (\d+) instruction slots used/);
    if (m) out.instrSlots = Number(m[1]);
    m = text.match(/dcl_temps (\d+)/);
    if (m) out.temps = Number(m[1]);
    // arrays indexed at runtime cannot live in registers: DXBC indexable temps, DXIL allocas, SPIR-V function arrays
    out.indexable = (text.match(/dcl_indexableTemp\s+x\d+\[\d+\]/g) || []).length + (text.match(/=\s*alloca\s/g) || []).length;
    // texture fetches: DXBC/DXIL/SPIR-V/GLSL spellings
    out.samples = body.filter((l) => /\b(sample(_[a-z]+)*|gather4[a-z_]*|ld(_[a-z]+)*\s|OpImage(Sample|Fetch|Gather)\w*|texture(Lod|Grad|Offset|Fetch)?\s*\(|texelFetch|dx\.op\.(sample|textureLoad|textureGather)\w*)/i.test(l)).length;
    out.loops = body.filter((l) => /\b(loop|OpLoopMerge|for\s*\(|while\s*\()/.test(l)).length;
    out.branches = body.filter((l) => /\b(if_[nz]+|if\s*\(|OpBranchConditional|discard|kill)\b/i.test(l)).length;
  }
  cache.set(key, out);
  return out;
}

export function statsLabel(st) {
  if (!st || !st.lines) return '';
  const parts = [];
  if (st.instrSlots !== undefined) parts.push(`${st.instrSlots} instr`);
  else parts.push(`${st.lines} lines`);
  if (st.samples) parts.push(`${st.samples} tex`);
  if (st.loops) parts.push(`${st.loops} loop`);
  if (st.temps !== undefined) parts.push(`${st.temps} temps`);
  if (st.indexable) parts.push(`${st.indexable} local arrays`);
  return parts.join(', ');
}

export function isDebugCompiled(s) {
  const cmd = (s.flags || []).find((f) => f[0] === '@cmdline');
  return !!(cmd && /(^|\s)[-/](Od|O0)(\s|$)/.test(cmd[1]));
}
