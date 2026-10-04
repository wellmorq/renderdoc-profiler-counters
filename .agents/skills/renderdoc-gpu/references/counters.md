# Counters

`metrics <rdc>` lists what was collected (with RenderDoc's own description for vendor counters); `metrics <rdc> <text>` also lists counters that exist for this GPU but were not fetched. `fetch <rdc> <set|exact names|re:regex>` adds them.

## Generic (every GPU; short keys used by the CLI)

| key | counter | what it counts | it does NOT tell you |
|---|---|---|---|
| `ms` | GPU Duration | timestamp duration of the event in replay | which unit limits it |
| `verts` | Input Vertices Read | vertices fetched by the input assembler | vertex stride/attributes, cache reuse |
| `prims` | Input Primitives | primitives assembled | — |
| `rastPrims` | Rasterized Primitives | primitives that reached the rasterizer (after culling/clipping) | covered pixels |
| `samples` | Samples Passed | samples passing depth/stencil | PS work (early-z, MSAA, helper lanes differ) |
| `vs`/`hs`/`ds`/`gs` | VS…GS Invocations | shader executions per stage | cost per execution |
| `ps` | PS Invocations | pixel shader executions (≈ shaded pixels incl. overdraw) | coverage vs overdraw vs MSAA split |
| `cs` | CS Invocations | compute threads | group shape, divergence |

Useful ratios (shown by `event` as `derived`): `ps / viewport pixels` (coverage+overdraw), `ns per ps invocation` (per-pixel cost), `vs / verts` (<1 = vertex cache reuse), `ps / rastPrims` (pixels per triangle; tiny values = micro-triangles).

## NVIDIA (Nsight Perf SDK)

Names are `<unit>__<metric>.<rollup>[.<submetric>]`:
- `.sum` — total over the event; additive across events. `.avg` — average across unit instances; **not** a total, don't re-normalise it. `.max/.min` — extremes.
- `.pct` / `.ratio` — percentage / ratio; over a marker the CLI shows a duration-weighted estimate prefixed `~`.
- `gpu__time_duration.sum`, `gpu__time_active.sum` are nanoseconds.
- Instruction counters (`sm__inst_executed`, `smsp__inst_executed_shader_<stage>`) count **warp** instructions (32 threads each), not source lines. Compare relatively.

Short names in tables: `inst`, `inst_ps`, `dramRd`, `dramWr`, `L1hit%`, `L2hit%`, `stall_<reason>%`.

Sets (`--counters` / `fetch`): `nv-time`, `nv-instructions`, `nv-memory`, `nv-stalls`, `nv-occupancy`, `nv-pack` (= all five, default on NVIDIA), `nv-all` (hundreds; slow).

| counter (prefix) | meaning | caution |
|---|---|---|
| `dram__bytes_op_read/write.sum` | bytes read/written to VRAM | high traffic ≠ bandwidth bound; divide by ms for GB/s and compare to the GPU's peak |
| `sm__inst_executed.sum` | warp instructions, all stages | mixes stages |
| `smsp__inst_executed_shader_ps/vs/cs.sum` | warp instructions of one stage | ÷ invocations ×32 ≈ instructions per thread only if warps were full |
| `l1tex__t_sector_hit_rate.avg.pct` | L1/texture cache hit rate | low hit rate matters only with significant traffic |
| `lts__t_sector_hit_rate.avg.pct` | L2 hit rate | average; can hide short bad regions |
| `tpc__average_registers_per_thread_shader_*` | registers per thread | high registers → fewer warps in flight (occupancy), not proof of a bottleneck |

Warp stall reasons (`smsp__warp_issue_stalled_<reason>_per_warp_active.avg.pct`: share of active warp time stalled for that reason). Read the top 2–3 only, and only after work and per-item cost:

| reason | plain meaning |
|---|---|
| `long_scoreboard` | waiting for texture/global memory data (L1TEX) — memory latency |
| `tex_throttle` | texture instruction queue full — too many texture fetches in flight |
| `lg_throttle` | local/global memory queue full (also register spills) |
| `math_pipe_throttle` | one math pipe oversubscribed (ALU-heavy code) |
| `short_scoreboard` | waiting on shared memory / special functions (sin, rcp, …) |
| `mio_throttle` | shared-memory/special-function queue full |
| `barrier` / `membar` | waiting at sync points (compute) |
| `wait` | fixed-latency dependency (normal ALU latency) |
| `no_instruction` | instruction fetch; normal for tiny workloads |
| `not_selected`, `selected` | scheduler states — not problems (high `not_selected` = enough warps to hide latency) |
| `dispatch_stall`, `drain`, `misc`, `sleeping`, `branch_resolving` | rarely actionable alone |

## Other vendors

AMD (GPA), Intel and ARM counters appear in `metrics` when the replay GPU provides them. Use their RenderDoc descriptions; the same three-layer method applies.
