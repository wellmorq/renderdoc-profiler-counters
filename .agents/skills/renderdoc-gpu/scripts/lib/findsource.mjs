// Rank shader source files in a project by overlap with identifiers from a captured shader's reflection.
import fs from 'node:fs';
import path from 'node:path';
import { table, trunc } from './format.mjs';

const EXT = /\.(shader|hlsl|hlslinc|cginc|compute|glsl|glslinc|vert|frag|comp|fx|fxh|usf|ush|shadergraph|shadersubgraph|raytrace)$/i;
const SKIP_DIRS = /^(\.git|\.vs|\.idea|node_modules|Temp|Logs|obj|Build|Builds|UserSettings|MemoryCaptures|ShaderCache|Bee|Artifacts|.*\.rdgpu)$/i;

// Engine-wide names that every Unity/URP/HDRP shader shares: they carry no identity.
const COMMON = new Set(`unity_ObjectToWorld unity_WorldToObject unity_MatrixVP unity_MatrixV unity_MatrixInvV unity_MatrixP
glstate_matrix_projection unity_LODFade unity_WorldTransformParams unity_RenderingLayer unity_LightData unity_LightIndices
unity_ProbesOcclusion unity_SpecCube0_HDR unity_SpecCube1_HDR unity_LightmapST unity_DynamicLightmapST unity_SHAr unity_SHAg
unity_SHAb unity_SHBr unity_SHBg unity_SHBb unity_SHC _Time _SinTime _CosTime unity_DeltaTime _TimeParameters _WorldSpaceCameraPos
_ProjectionParams _ScreenParams _ZBufferParams unity_OrthoParams _ScaledScreenParams _MainLightPosition _MainLightColor
_AdditionalLightsCount _GlobalMipBias unity_MatrixPreviousM unity_MatrixPreviousMI unity_MotionVectorsParams
UnityPerDraw UnityPerFrame UnityPerCamera UnityPerMaterial UnityLighting UnityShadows UnityPerCameraRare $Globals Globals
_MainLightShadowmapTexture unity_SpecCube0 unity_SpecCube1 unity_Lightmap unity_LightmapInd sampler_LinearClamp
sampler_PointClamp sampler_LinearRepeat main vert frag`.split(/\s+/).filter(Boolean));

function walk(root, out, depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.test(e.name)) continue;
      // Unity: only Library/PackageCache is useful inside Library
      if (e.name === 'Library') { walk(path.join(p, 'PackageCache'), out, depth + 1); continue; }
      if (depth < 14) walk(p, out, depth + 1);
    } else if (EXT.test(e.name)) {
      out.push(p);
    }
  }
}

function identifiers(s) {
  const ids = new Map(); // name -> weight hint
  const add = (n, w) => {
    if (!n || n.length < 3 || COMMON.has(n)) return;
    const base = n.replace(/\[.*$/, '').split('.').pop();
    if (!base || base.length < 3 || COMMON.has(base) || /^(cb|t|s|u|b)\d+$/.test(base) || /^_?\d/.test(base)) return;
    ids.set(base, Math.max(ids.get(base) || 0, w));
  };
  for (const cb of s.cbuffers || []) { add(cb.name, 1); for (const v of cb.vars) add(v.name, 1); }
  for (const t of s.textures || []) add(t.name, 1.5);
  for (const t of s.rw || []) add(t.name, 1.5);
  for (const n of s.samplers || []) add(n, 0.5);
  if (s.entry && !COMMON.has(s.entry)) add(s.entry, 2);
  for (const io of [...(s.inputs || []), ...(s.outputs || [])]) add(io.split(':')[0].replace(/\d+$/, ''), 0.3);
  return ids;
}

export function findSource(c, idSpec, project, opts = {}) {
  const s = c.shaderById.get(Number.isNaN(Number(idSpec)) ? idSpec : Number(idSpec)) || c.shaderById.get(idSpec);
  if (!s) throw new Error(`shader ${idSpec} not found (see \`shaders\`)`);
  const root = path.resolve(project);
  if (!fs.existsSync(root)) throw new Error(`project dir not found: ${root}`);
  const ids = identifiers(s);
  const named = s.name && !/^(Shader|Pixel Shader|Vertex Shader|Compute Shader)\s*\d+$/i.test(s.name) ? s.name : null;
  const files = [];
  walk(root, files);
  if (!files.length) return `No shader source files under ${root}.`;
  if (!ids.size && !named) return `Shader ${s.id} exposes no distinctive identifiers (no cbuffer/texture names). Use its disassembly and the marker path instead.`;
  const hits = [];
  const df = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (text.length > 4e6) continue;
    const found = [];
    for (const n of ids.keys()) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${n.replace(/[$]/g, '\\$')}([^A-Za-z0-9_]|$)`);
      if (re.test(text)) found.push(n);
    }
    let nameHit = false;
    if (named) {
      const esc = named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      nameHit = new RegExp(`Shader\\s+"${esc}"`).test(text);
    }
    for (const n of found) df.set(n, (df.get(n) || 0) + 1);
    if (found.length || nameHit) hits.push({ f, found, nameHit, size: text.length });
  }
  const N = files.length;
  for (const h of hits) {
    h.score = h.found.reduce((sum, n) => sum + ids.get(n) * Math.log(1 + N / (df.get(n) || 1)), 0) + (h.nameHit ? 50 : 0);
    if (/\.(shader|compute|shadergraph)$/i.test(h.f)) h.score *= 1.15;
  }
  hits.sort((a, b) => b.score - a.score);
  const out = [];
  out.push(`shader ${s.id} (${s.stage}${named ? `, "${named}"` : ''}); ${ids.size} identifiers: ${[...ids.keys()].slice(0, 20).join(', ')}${ids.size > 20 ? ', …' : ''}`);
  out.push(`scanned ${N} shader files under ${root}`);
  if (!hits.length) { out.push('no file contains any of these identifiers'); return out.join('\n'); }
  out.push(table(['score', 'matched', 'file', 'identifiers found'], hits.slice(0, opts.n || 8).map((h) => [
    h.score.toFixed(1), `${h.found.length}/${ids.size}${h.nameHit ? '+name' : ''}`, trunc(path.relative(root, h.f), 80),
    trunc(h.found.sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0)).join(', '), 70),
  ]), 'rrll'));
  out.push('Rare identifiers weigh more. Includes (.hlsl/.cginc) score high when they declare the cbuffer; the owning .shader is the one that #includes them.');
  if (s.sourceDir) out.push(`The capture also embeds this shader's compiled source: ${path.join(c.dir, 'shaders', s.sourceDir)}`);
  return out.join('\n');
}
