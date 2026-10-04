---
name: renderdoc-gpu
description: Analyze RenderDoc GPU captures (.rdc) from the command line — where frame time goes (passes, draws, dispatches, shaders), NVIDIA Nsight Perf hardware counters, pipeline state and constant-buffer values, shader source/disassembly, before/after regressions, and live shader-edit experiments measured in replay. Use whenever the user mentions a .rdc file, a RenderDoc capture, GPU frame performance, a slow pass/draw/shader, or wants to try a shader change and measure it.
---

# RenderDoc GPU capture analysis

All work goes through one CLI. `S` below means `node <dir of this SKILL.md>/scripts/rdgpu.mjs` (on Windows: `node <dir>\scripts\rdgpu.mjs`, quote paths with spaces); needs Node 18+ and RenderDoc installed. Typical setup: Windows, Unity, NVIDIA GPU.

```
S doctor --capture <file.rdc>      # once per machine/session: RenderDoc found? counters available?
S open <file.rdc>                  # replays once (seconds–minutes), builds a working cache, prints a summary
S tree|top|event|shaders|shader|find|metrics|compare ...   # instant, offline, from the cache
S draw|drawdiff|rt|source|experiment|usage ...             # replay the .rdc again for one question
S session <file.rdc>               # optional: keep the .rdc loaded in a background RenderDoc for a series of live commands
```
The `.rdc` is the only input and the source of truth. The cache (`%LOCALAPPDATA%\rdgpu\cache`, Linux `~/.cache/rdgpu`) is derived from it, rebuilt automatically when the file changes, and holds the shader dumps/edits/images you create. Every command takes the `.rdc` path. Run `S` without arguments for the full command list. Read command output; don't open cache JSON files unless a command lacks something.

Each live command loads the capture (seconds for small captures, up to a minute for big Unity ones). When you will run several live commands on the same capture (`draw`, `drawdiff`, `source`, `experiment`, `fetch`), start `S session <file.rdc>` first: those commands then reuse the loaded capture automatically. It exits by itself after 15 min idle (`--idle <sec>`), or `S session <file.rdc> --stop`.

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
| "What is slow / where does the frame go?" | `open` → `tree <rdc> . --depth 2` → `top <rdc> --in <pass>` → `event <rdc> <eid>` → `shaders <rdc>` |
| "Why is pass/draw X slow?" | `tree <rdc> X --metrics @work` (footer: draw-time distribution, draws with 0 pixels) → `event` on its top events → `draw <rdc> <eid>` for constants/textures → counters (§3) |
| "Which shader costs most / where is its code?" | `shaders <rdc>` → `shader <rdc> <id>` → `find-source <rdc> <id> --project <path>` |
| "What does this pass render?" | `rt <rdc> <eid>` → open the PNG (your file/image viewing tool) |
| "Before vs after — what regressed?" | `open` both → `compare <before> <after>` → for "SAME WORK, DIFFERENT COST" lines run the printed `drawdiff <before> <after> <eid>` (changed constants/textures/state) → `compare <before> <after> <marker>` for details |
| "Would change Y make it faster?" / "is it geometry or pixel cost?" | `source <rdc> <eid> --as <name>` (editable copy) → edit its main file → `experiment <rdc> <eid> --variant <name>=<file>` — read [references/experiments.md](references/experiments.md) first |
| Need a counter that is not collected | `metrics <rdc> <text>` (shows available ones) → `fetch <rdc> <names or preset>` |

`--metrics` / `--by` accept full counter names, the short names printed in table headers (`ps`, `verts`, `dramRd`, `L1hit%`, `stall_long_scoreboard%`, `inst_ps`), and groups: `@work` (pixels, vertices, primitives, samples, threads), `@memory` (DRAM bytes, L1/L2 hit), `@inst` (instructions per stage), `@stalls` (the 3 largest stall reasons in that region).

Narrowing rule: go frame → pass (marker) → top events → one event → its shader. Stop when the evidence answers the question. Prefer `--in`, `-n`, `--depth` over dumping everything.

Names: markers come from the engine (Unity: `RenderLoop.Draw`, `DrawOpaqueObjects`, `Render.OpaqueGeometry`, URP/HDRP pass names). Match with any substring; `tree`/`top --in` also accept an EID. `find <rdc> <text>` searches markers, shader names, cbuffer variable and texture names.

## 3. Reading the numbers (rules that prevent wrong answers)

- `ms` = GPU Duration measured during RenderDoc replay, per event. The frame total is a sum of events, not the game's frame time. Use it for **relative** cost; quote small (<0.05 ms) differences only with `--repeat` data.
- Marker rows are inclusive. Never add a parent and its children; compare siblings.
- `shaders` attributes a draw's whole time to each of its stages. Rank PS against PS, CS against CS; never sum stages.
- Values prefixed `~` (pct/ratio/avg counters over a marker) are duration-weighted estimates, not exact.
- A counter that was not fetched is unknown, not zero. Check `metrics` before claiming "no X".
- Shaders marked `/Od` or `compiled WITHOUT optimisation` (Unity debug pragma) are slower than in the shipped game; say this whenever such a shader is in your top list.
- Explain cost in three layers: **more work** (draws, vertices, pixels = `ps`, threads), **more work per item** (instructions, texture fetches, bytes per item), **less efficient execution** (cache hit rates, stalls). Lead with the work explanation in plain words; stall names come last. Method and NVIDIA counter meanings: [references/analysis-method.md](references/analysis-method.md), [references/counters.md](references/counters.md).
- `ps / viewport pixels` from `event` ≈ how many times each screen pixel was shaded by that draw (overdraw/coverage). Fullscreen passes ≈ 1.0. `MICRO-TRIANGLES` (<1 shaded pixel per triangle) means the cost is geometry density, not the pixel shader — don't read `ns per ps invocation` as shader cost then.
- `tree` footer for a marker: draw-time percentiles and how much time goes to draws that produce **0 pixels** (occluded/off-screen work) — a common Unity finding (missing occlusion culling, duplicate depth prepass).
- `WARNING replay GPU is a SOFTWARE rasterizer` (or `DEGRADED`): relative numbers only; clears and texture-heavy events are distorted. Say so in the answer.
- `summary` prints FINDINGS — heuristic leads (dominant draw, micro-triangles, 0-pixel draws, overdraw, expensive fullscreen passes, `/Od` shaders, software-replay artifacts). Verify each before reporting it; if the user asks for "top N" and fewer real problems exist, give fewer and say why — never pad the list with artifacts.
- Repeats: `--repeat N` on `open`/`fetch`/`experiment` stores min–max; `event` shows the range. When ranges of two things overlap, the difference is not proven.

## 4. Shader source

- `shader <rdc> <id>` shows whether the capture embeds source and where the disassembly is; `shader <rdc> <id> --src --grep <regex>` prints matching lines of the source (or disassembly) with line numbers — prefer grep over printing whole files.
- No embedded source (normal for Unity release shaders): use `find-source <rdc> <id> --project <unity project root>`; it ranks project/package shader files by the shader's cbuffer, texture and entry names. Ask the user for the project path if you don't know it (see §6). Unity pragmas to embed source and the `/Od` caveat: [references/unity-shaders.md](references/unity-shaders.md).
- When you quote code, say whether it is from the embedded source, a project file match (probable), or disassembly. Embedded source is the compiled language of the capture (HLSL for D3D, GLSL/SPIR-V for GL/Vulkan) and already preprocessed; map changes back to the project `.shader`/`.hlsl` yourself.
- A match under `Library/PackageCache/` (URP/HDRP) is read-only: propose the change in a copy (embedded package in `Packages/` or a custom shader in `Assets/`), never in the cache.

## 5. Output contract

Write the answer in the user's language. Structure (omit empty parts, keep it tight):

1. **Answer** — 1–3 sentences that directly answer the question in workload terms ("The bloom downsample runs a 25×25 tap blur on a half-resolution target: 625 texture fetches per pixel").
2. **Evidence** — a small table: event/marker (name + EID), ms and % of frame, the 2–4 counters that support the claim, before→after when comparing. Quote numbers from tool output, with units.
3. **Confidence** — `confirmed` (directly measured), `likely` (several counters agree), `hypothesis` (needs a check). One line per claim if they differ.
4. **Next steps** — 2–3 concrete checks or changes, each tied to the evidence (an `experiment` you can run, a counter to fetch, a setting to toggle in the engine). No generic optimisation lists.
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
