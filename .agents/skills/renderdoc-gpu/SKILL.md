---
name: renderdoc-gpu
description: Analyze RenderDoc GPU captures (.rdc) from the command line — where frame time goes (passes, draws, dispatches, shaders), NVIDIA Nsight Perf hardware counters, pipeline state and constant-buffer values, shader source/disassembly, before/after regressions, and live shader-edit experiments measured in replay. Use whenever the user mentions a .rdc file, a RenderDoc capture, GPU frame performance, a slow pass/draw/shader, or wants to try a shader change and measure it.
---

# RenderDoc GPU capture analysis

All work goes through one CLI. `S` below means `node <dir of this SKILL.md>/scripts/rdgpu.mjs` (on Windows: `node <dir>\scripts\rdgpu.mjs`, quote paths with spaces); needs Node 18+. Typical setup: Windows, Unity, NVIDIA GPU.

**First use on a machine — the backend must be installed.** The CLI drives [rdc-cli](https://github.com/BANANASJIM/rdc-cli), which needs RenderDoc's Python module **compiled locally** (git + C++ build tools — on Windows Visual Studio Build Tools with "Desktop development with C++"; the build takes 10–40 min). Run `S install` (idempotent; `--check` only reports). Run it with a long timeout or in the background and relay any `[NEED USER]` line (e.g. installing Build Tools needs an admin prompt, the Nsight Perf SDK download needs an NVIDIA login). Until the build is done, the CLI falls back to an installed RenderDoc (`qrenderdoc --python`, fewer features, no rdc tools). Details: [references/setup.md](references/setup.md).

```
S install                          # once per machine: uv + rdc-cli + RenderDoc Python module build + Nsight Perf SDK
S doctor --capture <file.rdc>      # once per session: backend works? which counters exist for this capture?
S open <file.rdc>                  # replays once (seconds–minutes), builds a working cache, prints a summary
S tree|top|event|shaders|shader|find|metrics|compare ...   # instant, offline, from the cache
S draw|drawdiff|rt|source|experiment|usage ...             # replay the .rdc again for one question
S session <file.rdc>               # optional: keep the .rdc loaded in a background RenderDoc for a series of live commands
```
The `.rdc` is the only input and the source of truth. The cache (`%LOCALAPPDATA%\rdgpu\cache`, Linux `~/.cache/rdgpu`) is derived from it, rebuilt automatically when the file changes, and holds the shader dumps/edits/images you create. Every command takes the `.rdc` path. Run `S` without arguments for the full command list. Read command output; don't open cache JSON files unless a command lacks something.

With the rdc backend every capture gets its own rdc daemon session (`rdgpu-<hash>`) on first use: the capture is loaded once and stays open (30 min idle), and every live command reuses it. `S session <file.rdc>` opens it explicitly and prints its name; with that name you can also run rdc-cli's own tools on the same open capture — `rdc --session <name> pipeline <eid>`, `bindings <eid>`, `debug pixel <eid> <x> <y>` (step through the shader for one pixel), `pixel <x> <y>` (pixel history), `mesh <eid>`, `tex-stats`, … (`rdc --help`). `S session <file.rdc> --stop` closes it. Sessions are per capture; before and after can be open together.

Results go to stdout, RenderDoc progress to stderr — don't merge them (`2>&1`) when you save or diff output; add `-q` to silence progress. Live commands take seconds; `experiment` can take minutes (≈ (variants + 2) × `--repeat` replays): give it a long timeout or run it in the background.

## 1. Setup (only when needed)

- `doctor` says `STATUS: ready` → go on. Otherwise follow its message. Details and troubleshooting: [references/setup.md](references/setup.md).
- The `COUNTERS` lines of the summary (and `doctor --capture`) say why vendor counters are or aren't there:
  - `NVIDIA counters UNAVAILABLE: Nsight Perf SDK not installed` → run `S setup-nvperf`. It finds/installs the SDK library if the user already downloaded it (it searches Downloads/Desktop); otherwise it prints what the **user** must download (NVIDIA login required — you cannot do it). Then `S fetch <rdc> nv-pack`. Meanwhile continue with generic counters.
  - `no vendor counters: replay GPU vendor is "..."` → this machine can't produce NVIDIA metrics (non-NVIDIA or software GPU). Don't install anything; say NVIDIA metrics need the capture replayed on an NVIDIA GPU.
  - `NVIDIA counters available` → `fetch <rdc> nv-pack` (default `open` already did) or specific names from `metrics <rdc> <text>`.
- `qrenderdoc ... waiting on a dialog` → ask the user to open RenderDoc once and answer its prompt.
- Capture replay fails (`cannot be replayed on this machine`) → the capture needs the same graphics API and a compatible GPU; say so and ask the user to run the analysis on the capturing machine.

## 2. Pick the path by question

| Question | Commands, in order |
|---|---|
| "What is slow / where does the frame go?" | `open` → `tree <rdc> . --passes --depth 3 --sort ms` (passes only, heaviest first) → `top <rdc> --in <pass>` → `event <rdc> <eid>` → `shaders <rdc>` |
| "Why is pass/draw X slow?" | `tree <rdc> X --metrics @work --sort ms` (footer: draw-time distribution, draws with 0 pixels) → `event` on its top events → `draw <rdc> <eid>` for constants/textures → counters (§3) |
| "Why is this fullscreen/post pass slow?" (bloom, blur, SSAO, UberPost) | `event <rdc> <eid>` (ns/pixel, formats) → `draw <rdc> <eid>` — its `LOOP BOUNDS FROM CONSTANTS` block gives the iterations per pixel (e.g. `_BlurTaps = 9`, nested → 81 reads) → `shader <rdc> <id> --src --grep "for *\(" -C 4` for the loop body |
| "Which shader costs most / where is its code?" | `shaders <rdc>` → `shader <rdc> <id>` → `find-source <rdc> <id> --project <path>` |
| "What does this pass render?" | `rt <rdc> <eid>` → open the PNG (your file/image viewing tool) |
| "Before vs after — what regressed?" | `open` both (two commands; they can run in parallel) → `compare <before> <after>` (read the `VERDICT` and `NOISE` lines first) → for "SAME WORK, DIFFERENT COST" lines run the printed `drawdiff <before> <after> <eid>` (changed constants/textures/state) → `compare <before> <after> <marker>` for details |
| "Would change Y make it faster?" / "is it geometry or pixel cost?" | `source <rdc> <eid> --as <name>` (editable copy) → edit its main file → `experiment <rdc> <eid> --variant <name>=<file>` — read [references/experiments.md](references/experiments.md) first |
| Need a counter that is not collected | `metrics <rdc> <text>` (shows available ones) → `fetch <rdc> <names or preset>` |

`--metrics` / `--by` accept full counter names, the short names printed in table headers (`ps`, `verts`, `dramRd`, `L1hit%`, `stall_long_scoreboard%`, `inst_ps`), and groups: `@work` (pixels, vertices, primitives, samples, threads), `@memory` (DRAM bytes, L1/L2 hit), `@inst` (instructions per stage), `@stalls` (the 3 largest stall reasons in that region), `@bytes` (`ropBytes`, `vtxBytes` estimates). `top` takes `--metrics` too (e.g. `top <rdc> --in Bloom --metrics ropBytes`).

Narrowing rule: go frame → pass (marker) → top events → one event → its shader. Stop when the evidence answers the question. Prefer `--passes`, `--in`, `-n`, `--depth` over dumping everything (`tree . --depth 2` without `--passes` lists every draw in Unity captures, because each draw sits in its own `RenderLoop.Draw` marker).

Names: markers come from the engine (Unity: `RenderLoop.Draw`, `DrawOpaqueObjects`, `Render.OpaqueGeometry`, URP/HDRP pass names). Match with any substring; `tree`/`top --in` also accept an EID. `find <rdc> <text>` searches markers, shader names, cbuffer variable and texture names.

## 3. Reading the numbers (rules that prevent wrong answers)

- `ms` = GPU Duration measured during RenderDoc replay, per event. The frame total is a sum of events, not the game's frame time. Use it for **relative** cost; quote small (<0.05 ms) differences only with `--repeat` data.
- Marker rows are inclusive. Never add a parent and its children; compare siblings.
- `shaders` attributes a draw's whole time to each of its stages. Rank PS against PS, CS against CS; never sum stages.
- Values prefixed `~` (pct/ratio/avg counters over a marker) are duration-weighted estimates, not exact.
- A counter that was not fetched is unknown, not zero. Check `metrics` before claiming "no X".
- Shaders marked `/Od` or `compiled WITHOUT optimisation` (Unity debug pragma) are slower than in the shipped game; say this whenever such a shader is in your top list.
- Explain cost in three layers: **more work** (draws, vertices, pixels = `ps`, threads), **more work per item** (instructions, texture fetches, bytes per item), **less efficient execution** (cache hit rates, stalls). Lead with the work explanation in plain words; stall names come last. Method and NVIDIA counter meanings: [references/analysis-method.md](references/analysis-method.md), [references/counters.md](references/counters.md). **Mechanisms and how to explain them in plain words (heavy vertices, interpolants, register spilling, wide formats/blending/ROP, texture bandwidth, overdraw, micro-triangles…): [references/bottlenecks.md](references/bottlenecks.md) — read it before writing the "why".**
- State evidence beats guesses: `event` shows the vertex layout (attributes, bytes per vertex), interpolant count, colour formats with bytes per pixel and blending, sampled texture formats/sizes/mips and register-pressure hints; `ropBytes`/`vtxBytes` (`--metrics @bytes`) estimate output and vertex-fetch traffic; `compare` lists `STATE / FORMAT CHANGES` per changed pass. Use NVIDIA sets `nv-rop`, `nv-spill`, `nv-geometry` (in `nv-pack`) to confirm.
- `ps / viewport pixels` from `event` ≈ how many times each screen pixel was shaded by that draw (overdraw/coverage). Fullscreen passes ≈ 1.0. `MICRO-TRIANGLES` (<1 shaded pixel per triangle) means the cost is geometry density, not the pixel shader — don't read `ns per ps invocation` as shader cost then.
- `tree` footer for a marker: draw-time percentiles and how much time goes to draws that produce **0 pixels** (occluded/off-screen work) — a common Unity finding (missing occlusion culling, duplicate depth prepass).
- `WARNING replay GPU is a SOFTWARE rasterizer` (or `DEGRADED`): relative numbers only (say "share of the frame", not "costs X ms on the GPU"); clears and texture-heavy events are distorted, and memory bandwidth/ROP limits of a real GPU don't show up in ms at all — they show up only in work estimates (`ropBytes`, formats). Say so in the answer. Between two such captures, treat a per-event time change as real only when `drawdiff` (or work counters / shader code) shows a matching difference; otherwise call it noise.
- `compare` prints `VERDICT` lines (time vs work per changed pass) and a `NOISE` line: how much markers with unchanged work moved between the two replays. Changes inside that band are not evidence; "all in one direction" means a global shift — compare shares of the frame.
- `summary` prints FINDINGS — heuristic leads (dominant draw, micro-triangles, 0-pixel draws, overdraw, expensive fullscreen passes, `/Od` shaders, software-replay artifacts). Verify each before reporting it; if the user asks for "top N" and fewer real problems exist, give fewer and say why — never pad the list with artifacts.
- Repeats: `--repeat N` on `open`/`fetch`/`experiment` stores min–max; `event` shows the range. When ranges of two things overlap, the difference is not proven.

## 4. Shader source

- `shader <rdc> <id>` shows whether the capture embeds source and where the disassembly is; `shader <rdc> <id> --src --grep <regex> -C <lines>` prints matching lines of the source (or disassembly) with line numbers and context (default 2) — prefer grep over printing whole files; raise `-C` to read a loop body.
- No embedded source (normal for Unity release shaders): use `find-source <rdc> <id> --project <unity project root>`; it ranks project/package shader files by the shader's cbuffer, texture and entry names. Ask the user for the project path if you don't know it (see §6). Unity pragmas to embed source and the `/Od` caveat: [references/unity-shaders.md](references/unity-shaders.md).
- When you quote code, say whether it is from the embedded source, a project file match (probable), or disassembly. Embedded source is the compiled language of the capture (HLSL for D3D, GLSL/SPIR-V for GL/Vulkan) and already preprocessed; map changes back to the project `.shader`/`.hlsl` yourself.
- Experiments run in the capture's own shader language. On a GL/Vulkan capture your tested edit is GLSL; a port to the project's HLSL is untested — say so.
- A match under `Library/PackageCache/` (URP/HDRP) is read-only: propose the change in a copy (embedded package in `Packages/` or a custom shader in `Assets/`), never in the cache.

## 5. Output contract

Write the answer in the user's language, in two parts:

**Answer the question that the data supports.** If the user's premise doesn't hold (they ask "what got slower", but the measured time went down; they expect a pass to be the culprit, but it's cheap), say that first, plainly, then give what the data does show — e.g. "measured: Bloom is 82% faster in this replay, but it now moves ~14× more bytes through pixel output (32-bit float targets + blending); on a real GPU that is the likely slowdown". Never bend the evidence to fit the premise, and never drop the risk because the ms look good.

**Part 1 — Summary (short, first).** 3–6 lines a busy person reads: what is slow / what changed, how much (ms and % of frame), and the mechanism in plain words — what the GPU does too much of and why it hurts ("the new bloom writes 16-byte float pixels with blending, so each pixel is read and written twice at double width: ~6× more data out of the pixel shader for fewer instructions"). No jargon without a translation; at most one or two numbers per line.

**Part 2 — Details.**
1. **Evidence** — a table per finding: pass/event (name + EID), ms and % of frame (before→after when comparing), the 2–4 counters or state facts that prove it (formats, bytes/vertex, ps, ropBytes, constants). Quote tool output with units.
2. **Why** — a short paragraph per finding explaining the mechanism (use [references/bottlenecks.md](references/bottlenecks.md)) and ruling out the obvious alternatives you checked ("pass count grew 4→21, but those passes are tiny: X ms total").
3. **Confidence and caveats** — `confirmed` / `likely` / `hypothesis` per claim; estimates (`ropBytes`), software/degraded replay, missing NVIDIA counters, noise.
4. **Suggestions (careful)** — 2–4 options tied to the evidence, each with the expected effect and how to verify (an `experiment`, a counter, a recapture). Phrase as "likely/should", not promises.
5. **Artifacts** — paths you produced (images, edited shaders) when relevant.

Templates and examples: [references/output-format.md](references/output-format.md).

## 6. When to ask the user

Ask only when the answer would change what you do; otherwise state the assumption and proceed. Ask everything you need **in one message**, each question with a default, e.g.:

> 1. Which capture is "before"? (default: older file time → before)  2. Unity project root for source lookup? (default: skip source lookup)

Ask when: several `.rdc` files and no indication which; NVIDIA counters needed but SDK missing (user must download); source lookup needs a project path you cannot find; a requested change can't be tested in replay (asset/scene change). Never ask to confirm running read-only commands.

## 7. Don'ts

- Don't infer the game's frame time, CPU cost, or what changed in the code/assets from GPU counters alone.
- Don't call a draw "vertex bound"/"ROP bound" without the counters that show it; describe the work first.
- Don't present a shader experiment as a win without the `image vs captured` column (how many texels changed and by how much — PSNR/max error) and the `significant` column, comparing against the `original` row.
- Don't re-run `open` to "refresh": the cache is reused automatically; use `--force` only after re-capturing or installing the Nsight Perf SDK.
