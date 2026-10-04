# Shader experiments in replay

`experiment` replaces one shader in RenderDoc's replay, re-measures, and restores it. Nothing in the game or project changes. Use it to test a hypothesis ("the 25-tap blur is the cost") with numbers instead of guesses.

## Workflow

```
S source <rdc> <eid> [--stage ps|vs|cs]        # writes <cache>/edit/eid<E>-<stage>/original/ (+ meta.json); prints the paths
S source <rdc> <eid> --as fewer_taps            # editable copy per variant; edit its main file only
S experiment <rdc> <eid> --stage ps --variant fewer_taps=<path printed by source> [--variant b=...] [--repeat 5] [--images]
```

- Each `source --as <name>` writes a fresh, unmodified copy of the captured source into its own directory — edit it in place; don't copy directories by hand. (A plain `source` without `--as` writes `original/`, for reading only.) Re-running `--as <name>` overwrites that copy.
- The main file is printed by `source` (`main file:`); `#include`s are resolved from the files next to it, like RenderDoc's own editor.
- `--repeat` defaults to 5 (7 on software GPUs).
- Keep the entry point, inputs/outputs and resource bindings unchanged; change only the body.
- Variants compile with the captured compiler flags. Add `--flags-remove /Od --flags-add /O3` to measure optimised code (applies to all variants including `original`).
- Without embedded source (`source` says so), only disassembly is available: either recapture with debug info (unity-shaders.md) or write a full replacement shader by hand.

## Reading the result

```
variant                  eid 575  all users  Δ users vs original  significant  image vs captured
captured  439.02 [431.62–440.35]     660.28                -6.9%  yes          0%
original  449.16 [444.49–488.93]     709.55                                    0%
step2     128.37 [122.51–130.82]     192.14               -72.9%  yes          10.679% max 0.007721 mean 0.0000473 psnr 66dB
per event (median):  eid 575  eid 584  eid 593  eid 602 ...
```

- `captured` = the shader as it was in the capture; `original` = its source recompiled by RenderDoc. **Judge variants against `original`** (same compiler, same flags). A large captured↔original gap means the compiler/flags differ (e.g. `/Od` capture) — mention it.
- `eid N` = median [min–max] over `--repeat` replays. `significant` = `yes` when the min–max ranges of the variant and the baseline don't overlap; otherwise raise `--repeat` (5 default; 7–9 on noisy machines) before claiming anything.
- `all users` = sum over every event that uses this shader (the replacement affects all of them); the per-event table shows each one.
- `image vs captured` = render target 0 after this event versus the captured output: % of texels that changed, the largest and the mean absolute per-channel error (linear float values; 1.0 = white for 8-bit targets, HDR targets can exceed 1) and PSNR. Rough guide for 8-bit-visible results: max < 0.004 (1/255) invisible, PSNR > 50 dB visually identical, < 35 dB likely visible. Look at `--images` PNGs when it matters; dark/HDR targets can look black in PNG — rely on the numbers then. A variant that writes nothing can show 0% because the target keeps its previous contents.
- Compiler warnings/errors are printed per variant; a failed compile shows `FAILED` with the first lines of the error.

## Good experiments

- Remove or reduce one thing per variant (taps, loop count, a texture fetch, a branch) so the delta is attributable.
- To prove "this part of the shader is the cost": a variant with that part replaced by a constant, and check `image vs captured` to see what it affected.
- **Geometry or pixel cost?** Make a `--as null` copy whose pixel shader body only writes a constant colour (keep the signature and outputs: HLSL `return float4(0,0,0,1);`, GLSL `outColor = vec4(0,0,0,1);`). If the event barely gets faster, the cost is vertex/raster (geometry density, micro-triangles); if it collapses, it is the pixel shader. Then remove one feature at a time (texture fetch, light loop, shadow sampling) to find which part costs.

  | null-PS result | `event` says | conclusion |
  |---|---|---|
  | barely faster | — | vertex/raster cost: geometry density, vertex shader, primitive count |
  | collapses | normal px/tri | the pixel shader itself is expensive → remove features one by one |
  | collapses | `MICRO-TRIANGLES` | the PS runs once per tiny triangle (2×2 quads, helper lanes): cost scales with triangles. Fix the mesh/LOD first; cheaper PS features only reduce it. Report both facts |

  A vertex-shader variant that moves everything off-screen also removes all pixel work, so it says nothing about VS cost on its own. To compare draws that share a shader, use `tree <rdc> <pass> --metrics @cost` (ns per pixel, µs per triangle, pixels per triangle).
- To estimate a quality/perf trade-off: two or three settings (e.g. 25/13/9 taps) in one run.
- To test whether optimisation flags matter: the same source with `--flags-remove /Od` vs without (two runs).
- Report: what changed (diff summary), ms before/after for the event and users, % vs original, visual impact, and how to port it to the project file.
