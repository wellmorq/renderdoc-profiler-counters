# renderdoc-gpu

An agent skill + CLI for analysing RenderDoc GPU captures (`.rdc`) without the RenderDoc UI: where frame time goes, NVIDIA Nsight Perf hardware counters, pipeline state and constant values, shader source/disassembly, before/after regressions, and shader-edit experiments measured in replay.

It runs on top of [rdc-cli](https://github.com/BANANASJIM/rdc-cli): each capture gets an rdc daemon that keeps it loaded, the skill's extraction and experiments run inside that daemon, and the agent can use rdc's own tools (shader debugging, pixel history, mesh export) on the same open capture. The `.rdc` is the only input; what the CLI extracts is kept in a working cache (`%LOCALAPPDATA%\rdgpu\cache`, Linux `~/.cache/rdgpu`) so follow-up queries are instant.

Primary target: Windows + Unity (D3D11/D3D12/Vulkan captures, URP/HDRP/built-in markers, Unity debug pragmas) on NVIDIA GPUs. Linux works too.

## Installation (done by the agent)

Give your coding agent (Codex, OpenCode, …) this repository URL and ask it to install the skill. The agent should:

1. Clone the repository and copy `.agents/skills/renderdoc-gpu` into the skills directory it reads (project or user level, e.g. `<project>/.agents/skills/` or `~/.agents/skills/`).
2. Run `node <skills dir>/renderdoc-gpu/scripts/rdgpu.mjs install` — **this builds RenderDoc's Python module locally** through `rdc setup-renderdoc`: it needs git and a C++ toolchain (Windows: Visual Studio Build Tools with "Desktop development with C++") and takes 10–40 minutes. It installs uv and rdc-cli on the way and reports `[NEED USER]` for anything a person must do (admin prompt for Build Tools, NVIDIA login for the Nsight Perf SDK download).
3. Run `node …/rdgpu.mjs doctor --capture <some .rdc>` and confirm `STATUS: ready`.

Requirements: Node.js 18+, git, a C++ toolchain, network access to github.com and PyPI during install. Optional: the Nsight Perf SDK for NVIDIA hardware counters (`setup-nvperf` copies it into RenderDoc's plugin folder once downloaded). Without the rdc build the CLI falls back to an installed RenderDoc (`qrenderdoc --python`) with fewer features.

## Use it directly

```
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs doctor --capture frame.rdc
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs open frame.rdc
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs tree frame.rdc DrawOpaqueObjects --metrics ps,verts
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs compare before.rdc after.rdc
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs experiment frame.rdc 575 --variant fewer_taps=edit/v1/main.hlsl
```

`session <capture>` prints the rdc session name of a capture, so rdc-cli commands can be run on the same open capture (`rdc --session <name> debug pixel <eid> <x> <y>`). Run the CLI without arguments for every command. `SKILL.md` describes the workflow agents follow; `references/` holds setup/troubleshooting, counter meanings, the analysis method, Unity debug pragmas, experiment guidance and answer formats.

## Repository layout

| path | what |
|---|---|
| `.agents/skills/renderdoc-gpu/` | the skill (SKILL.md, CLI in `scripts/`, references) |
| `scripts/rdjob.py` | runs inside RenderDoc's Python (3.6-compatible): extraction, counters, state, shaders, experiments |
| `scripts/lib/*.mjs` | install, rdc-cli backend, host discovery, job runner, cache model, queries, compare, find-source, Nsight Perf setup |
| `tests/rdgpu.test.mjs` | `node --test tests/rdgpu.test.mjs` (offline); set `RDGPU_TEST_CAPTURE=<.rdc>` to also run a live replay test |
| `dev/gl-scene/scene.py` | synthetic URP-like OpenGL frame used to produce test captures (runs on Mesa llvmpipe under Xvfb) |
| `dev/fixtures/MiniUnityProject/` | tiny Unity-like project for `find-source` tests |
