# Analysis method

## 1. Locate the cost

1. `summary` (printed by `open`): frame total, top passes, top events, top shaders.
2. `tree <rdc> . --depth 2` → the dominant pass → `tree <rdc> <pass> --depth 3 --metrics ps,verts`.
3. `top <rdc> --in <pass> -n 15` → the events that make the pass expensive. A pass is usually either *few heavy draws* (fullscreen/post effects, one huge mesh) or *many cheap draws* (draw-call count, state changes) — say which.
4. `event <rdc> <eid>` on the top 1–3 events; `shaders <rdc> --in <pass>` to see which shaders dominate.

Concentration matters: "one draw = 51% of the frame" is a different story from "3000 draws × 0.01 ms".

## 2. Explain it in three layers

Work first, mechanism last.

**More work** — count of items processed: draws/dispatches, `verts`, `rastPrims`, `ps` (shaded pixels), `cs` threads, render-target size (`event` → render targets, viewport).
- "The pass shades 4.9 M pixels: ≈ 5.3 full 1920×1080 screens (overdraw from 420 stacked particles)."
- "240 k triangles but only 22 k shaded pixels: ~0.1 pixel per triangle — the mesh is far too dense for its screen size."

**More work per item** — per-pixel/vertex/thread cost: `ns per ps invocation`, instructions per invocation (NVIDIA), texture fetches and loop counts in `shader` static stats, constant values that drive loops (`draw <rdc> <eid>`: e.g. light count, blur tap count, sample count), bytes per item.
- "Same pixel count; the light loop runs 24 iterations instead of 4 (`_AdditionalLightsCount` 4 → 24 in `draw`), so each pixel costs ~2.3× more."

**Less efficient execution** — only after the above: cache hit rates, warp stalls, register pressure (NVIDIA counters). Translate stall names (see counters.md).
- "Work is unchanged, but L1 hit rate fell 92% → 61% and long-scoreboard stalls rose: texture reads became less cache friendly (larger/uncompressed texture or scattered UVs)."

Pick the denominator that matches the dominant stage. Don't divide whole-pass DRAM bytes by vertices and call it vertex-fetch cost.

## 3. Before/after regressions

1. `compare <before> <after>` — frame Δ, markers sorted by |Δms|, "WORK vs COST" lines, shader table with `code same/CHANGED`.
2. Check comparability first: WARNING lines (API, vendor, resolution, counter sets), `topology:` line (markers added/removed → parent totals cover different events).
3. `compare <before> <after> <marker>` for the region that moved most → REGION table + "reading".
4. Classify: work changed (`ps`, `verts`, draws), per-item cost changed (ms per item, `code CHANGED`, static stats, constants via `draw` on both), or efficiency changed (caches/stalls with same work).
5. `code same` but cost up → data-driven change (constants, textures, resolution, overdraw): `compare` prints `SAME WORK, DIFFERENT COST` lines with a ready `drawdiff <before> <after> <eid>` command; it lists only the constants, texture bindings/sizes, targets and pipeline state that differ (e.g. `_BlurTaps 9 → 25`, `_AdditionalLightsCount 4 → 24`). Loop-bound shaders (static stats show `loop`) are the first suspects.

## 4. Evidence discipline

- confirmed = directly in tool output; likely = ≥2 consistent signals; hypothesis = needs a check. Label claims.
- Timing noise: replay timings vary a few %. For deltas under ~5% on small events, re-measure (`fetch <rdc> generic --repeat 5`) before concluding.
- One counter or correlation is rarely enough for a causal claim.
- Never fill a missing counter with a guess. Never claim "X disappeared" from an unmeasured event.
- The capture shows GPU work only: no CPU time, no game frame time, no asset/source diffs.

## 5. Common culprits (and the check that confirms each)

| pattern in data | likely cause | discriminating check |
|---|---|---|
| fullscreen pass, `ps ≈ RT pixels`, high ns/pixel, many tex in static stats | expensive post effect (blur taps, SSR/SSAO samples) | `draw` constants (tap/sample counts), `experiment` with fewer taps |
| `ps / viewport pixels` ≫ 1 on blended draws | overdraw (particles, UI, transparent stacks) | `rt` before/after the draw; reduce particle count/size in a test |
| huge `verts`/`rastPrims`, tiny `ps` | over-tessellated / no LOD | `event` ps per primitive; check LOD settings in engine |
| shadow pass large, many draws, `ps` = 0 | shadow casters count/resolution | `tree MainLightShadow` draws, depth target size in `event` |
| shader `/Od` in top list | Unity debug pragma left on | recapture without it or `experiment --flags-remove /Od` |
| same work, higher ms, lower hit rates | texture size/format/sampling pattern | `draw` texture sizes/formats in both captures |
| many tiny draws (≪0.01 ms each) adding up | draw-call/state overhead, missing batching/instancing | count in `tree`, GPU idle gaps are not visible here |
| `tree` footer: many draws with 0 samples/pixels | objects fully occluded or off-screen still submitted (no occlusion culling, too-far camera range) | count/time/vertices of those draws; Unity: Occlusion Culling / GPU Resident Drawer settings |
| depth prepass and GBuffer with the same vertex counts | geometry processed twice; prepass only pays off with heavy overdraw | `tree <prepass> --metrics @work` vs `tree GBuffer --metrics @work`; prepass `ps` ≫ screen pixels = alpha-tested materials in prepass |
| `MICRO-TRIANGLES` in `event` | mesh far denser than its screen size | LOD settings; `experiment` with a constant pixel shader barely helps |
