# Shader experiments in replay

`experiment` replaces one shader in RenderDoc's replay, re-measures, and restores it. Nothing in the game or project changes. Use it to test a hypothesis ("the 25-tap blur is the cost") with numbers instead of guesses.

## Workflow

```
S source <rdc> <eid> [--stage ps|vs|cs]        # writes <rdc>.rdgpu/edit/eid<E>-<stage>/original/ (+ meta.json)
S source <rdc> <eid> --as fewer_taps            # editable copy per variant; edit its main file only
S experiment <rdc> <eid> --stage ps --variant fewer_taps=<path printed by source> [--variant b=...] [--repeat 5] [--images]
```

- The main file is printed by `source` (`main file:`); `#include`s are resolved from the files next to it, like RenderDoc's own editor.
- Keep the entry point, inputs/outputs and resource bindings unchanged; change only the body.
- Variants compile with the captured compiler flags. Add `--flags-remove /Od --flags-add /O3` to measure optimised code (applies to all variants including `original`).
- Without embedded source (`source` says so), only disassembly is available: either recapture with debug info (unity-shaders.md) or write a full replacement shader by hand.

## Reading the result

```
variant          eid 575   users   frame  Δ vs captured  Δ vs original  px changed
captured   68.18 [65–70]   99.89  588.39           0.0%          -3.9%          0%
original   65.35 [62–68]  103.97  596.27           4.1%                         0%
taps3      8.48 [7.5–9.6]  12.96  475.63         -87.0%         -87.5%     12.4%
```

- `captured` = the shader as it was in the capture; `original` = its source recompiled by RenderDoc. **Judge variants against `original`** (same compiler, same flags). A large captured↔original gap means the compiler/flags differ (e.g. `/Od` capture) — mention it.
- `eid N` = median [min–max] over `--repeat` replays of the chosen event. Overlapping ranges = no proven difference; raise `--repeat`.
- `users` = sum over every event that uses this shader (the replacement affects all of them); `frame` = whole replay total.
- `px changed` = share of render-target-0 texels after this event that differ from the captured output. 0% = identical image. Any non-zero value means the variant changes what is drawn: look at the images (`--images`, then open the PNGs) and describe the visual cost of the optimisation. A variant that writes nothing can still show 0% because the target keeps its previous contents — another reason to look at images when the speed-up is suspiciously large.
- Compiler warnings/errors are printed per variant; a failed compile shows `FAILED` with the first lines of the error.

## Good experiments

- Remove or reduce one thing per variant (taps, loop count, a texture fetch, a branch) so the delta is attributable.
- To prove "this part of the shader is the cost": a variant with that part replaced by a constant, and check `px changed` to see what it affected.
- To estimate a quality/perf trade-off: two or three settings (e.g. 25/13/9 taps) in one run.
- To test whether optimisation flags matter: the same source with `--flags-remove /Od` vs without (two runs).
- Report: what changed (diff summary), ms before/after for the event and users, % vs original, visual impact, and how to port it to the project file.
