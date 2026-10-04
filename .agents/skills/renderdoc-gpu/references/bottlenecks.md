# Bottleneck mechanisms — evidence and plain-language explanations

Use this to turn numbers into an explanation the user can act on. For each finding say **what the GPU is doing too much of, why that is slow, and what would change it** — in two or three ordinary sentences. Jargon (ROP, spilling, occupancy, scoreboard) may appear once in parentheses, never as the explanation itself.

Every row: signals to look for (CLI output) → plain explanation → how to confirm → cautious suggestion.

## Geometry side

**Heavy vertices (fat vertex format)**
- Signals: `event` → `vertex layout: N attributes = X B/vertex` with `HEAVY VERTICES` (> 64 B), many `R32…_FLOAT` attributes; `vtxBytes` large in `tree --metrics @bytes`; NVIDIA `nv-geometry` (vertex attribute fetch) busy.
- Explain: "Every vertex of this mesh carries 224 bytes of data (15 attributes, all 32-bit floats). The GPU has to read all of it for each of the 115k vertices before it can even start drawing — about 25 MB per draw. Most of these values could be stored at half size or dropped."
- Confirm: compare the same mesh in another draw/capture; `experiment` on the VS that ignores unused attributes does *not* reduce fetch (layout is fixed) — confirmation is the layout itself plus vertex-stage counters.
- Suggest (cautiously): remove unused channels in the model import / mesh compression (Unity: Mesh Compression, vertex channel stripping, half-precision UV/normals), split rarely used data into a separate stream.

**Too many interpolants (VS → PS varyings)**
- Signals: `event` → `VS→PS interpolants: 17 outputs … many varyings`.
- Explain: "The vertex shader passes 17 values to the pixel shader for every vertex. They must be stored on chip and interpolated for every pixel, which limits how many vertices and pixels the GPU can keep in flight."
- Suggest: pack values, compute some in the pixel shader, remove unused outputs.

**Micro-triangles / mesh too dense**: `MICRO-TRIANGLES` in `event` or FINDINGS. "240k triangles cover only 22k pixels — about ten triangles per pixel. The GPU still processes each triangle and shades pixels in 2×2 blocks, so most of the work is wasted on detail nobody can see." → LOD / decimated mesh.

**Work on invisible objects**: `tree` footer `draws with 0 samples`. "N objects are drawn but none of their pixels survives the depth test — they are hidden behind others or outside the view, yet the GPU still transforms all their vertices." → occlusion culling, draw distance, smaller shadow-caster lists.

## Pixel output (ROP) side

**Wide render-target formats and blending (ROP / output bandwidth)**
- Signals: `event` → `colour output: R32G32B32A32_FLOAT 16 B/px blended → ≈X B ROP traffic`; `ropBytes` grew in `compare`; `STATE / FORMAT CHANGES` shows `output formats R16G16B16A16_FLOAT (8 B/px) → R32G32B32A32_FLOAT (16 B/px) blended`; same pixel count but more time; NVIDIA `nv-rop` (crop/zrop) busy.
- Explain: "The new bloom writes its results in 32-bit-per-channel colour (16 bytes per pixel instead of 8) and mostly with blending, which means every pixel is read back and written again. For the same number of pixels the GPU now moves about 4× more data through the units that write pixels to memory; the shader itself got cheaper, but output became the limit."
- Confirm: `ropBytes` vs `ms` across the changed passes; draw-level `event` on the heaviest pass; NVIDIA ROP counters if available; `experiment` cannot change formats (state) — the evidence is state + counters.
- Suggest: use R11G11B10_FLOAT / R16G16B16A16_FLOAT for HDR intermediates, avoid blending where a single write suffices, merge additive passes.

**Overdraw**: `ps / viewport pixels` ≫ 1 on blended draws, FINDINGS `blended overdraw`. "Each screen pixel under the smoke is shaded ~80 times because 420 large transparent quads are stacked on top of each other." → fewer/smaller particles, sort/cull, lower-res particle buffer.

**MSAA**: `xMSAA` on targets: each pixel stores/resolves N samples → output and memory cost ×N.

## Shader execution

**Long loops / many texture reads per pixel**: static stats `loop`, `tex`; `drawdiff` `LIKELY COST DRIVERS`; high `ns/px` on fullscreen passes. "The blur reads the texture 625 times for every pixel (a 25×25 kernel)."

**Expensive texture reads (bandwidth / cache misses)**: `event` → `ps reads:` uncompressed or float formats (`R32G32B32A32_FLOAT`, `R16G16B16A16_FLOAT`), large sizes, `mips=1` on textures that are minified; NVIDIA L1/L2 hit rates low, `long_scoreboard`/`tex_throttle` stalls high. "The shader samples a 4096² uncompressed float texture without mipmaps; neighbouring pixels read far-apart texels, so the caches keep missing and the GPU waits for memory." → compressed formats (BC6H/BC7), mipmaps, lower precision.

**Register pressure and spilling**
- Signals: `event` → `register pressure: … indexable temp array(s) → likely kept in slow local memory ("spilled")`, DXBC `dcl_temps` ≥ 32; static stats `N local arrays`; NVIDIA `nv-spill` (local-memory load/store traffic > 0, registers per thread high), `lg_throttle` stall.
- Explain: "The vertex shader needs more temporary storage than the GPU's fast registers can hold, so part of its working data is pushed out to much slower memory and read back again. That also lets fewer shader instances run at once, so the GPU has less work to hide memory delays with."
- Confirm: NVIDIA local-memory counters > 0 for that stage; an `experiment` that removes the dynamically indexed array / big loop and drops time.
- Suggest: avoid dynamically indexed local arrays, shorten live ranges, split the shader, reduce unrolled loops.

**Divergent branches**: many `branch`es in static stats, NVIDIA `branch_resolving` stall. "Neighbouring pixels take different paths through the shader, so the GPU runs both paths for the group."

**Unoptimised shaders**: `/Od` flags. "This shader was compiled in debug mode (Unity debug pragma), so it runs without optimisation — its cost here is higher than in the shipped game."

## Frame structure

- **Duplicate geometry passes**: depth prepass and GBuffer with the same `verts` (`tree <pass> --metrics @work`). "All geometry is processed twice; the prepass only pays off when it prevents a lot of expensive pixel shading."
- **Pass count changes** (`compare` → `draws 4 → 21`, new markers): more passes cost fixed setup per pass plus their own writes; check whether the added passes or a format change dominates (`ropBytes`, per-marker ms).
- **Full-resolution post effects**: fullscreen pass at native resolution with high `ns/px` — consider half resolution.

## Wording rules for the answer

1. Short summary first (2–4 sentences): which pass, how much, the mechanism in plain words.
2. Then details with numbers: table + "why" paragraph per finding + caveats (software GPU, noise, estimates such as `ropBytes`, missing NVIDIA counters).
3. Suggestions phrased as options with expected effect and risk ("likely", "should", "verify by …"), never as certainties unless an `experiment` measured them.
