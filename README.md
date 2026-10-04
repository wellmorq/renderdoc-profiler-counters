# renderdoc-gpu

An agent skill + CLI for analysing RenderDoc GPU captures (`.rdc`) without the RenderDoc UI: where frame time goes, NVIDIA Nsight Perf hardware counters, pipeline state and constant values, shader source/disassembly, before/after regressions, and shader-edit experiments measured in replay.

It drives the RenderDoc you already have installed: every replay step runs headless inside `qrenderdoc --python`, so nothing has to be built. Results are cached next to the capture (`<capture>.rdc.rdgpu/`) and all analysis queries are instant afterwards.

## Install the skill

Copy the folder `.agents/skills/renderdoc-gpu` (keep `SKILL.md`, `scripts/`, `references/`) into the skills directory your coding agent reads, per project or per user — e.g. `<project>/.agents/skills/` or `~/.agents/skills/` (Codex, OpenCode), or your agent's own skills folder. The skill is plain Markdown plus a Node CLI, so it works with any agent that can run shell commands.

Primary target: Windows + Unity (D3D11/D3D12/Vulkan captures, URP/HDRP/built-in markers, Unity debug pragmas). Linux works too.

Requirements: Node.js 18+, RenderDoc 1.x (https://renderdoc.org/builds). For NVIDIA counters, the Nsight Perf SDK host library — the CLI installs it from the SDK download (`setup-nvperf`); the download itself needs an NVIDIA developer login.

## Use it directly

```
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs doctor --capture frame.rdc
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs open frame.rdc
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs tree frame.rdc DrawOpaqueObjects --metrics ps,verts
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs compare before.rdc after.rdc
node .agents/skills/renderdoc-gpu/scripts/rdgpu.mjs experiment frame.rdc 575 --variant fewer_taps=edit/v1/main.hlsl
```

Run it without arguments for every command. `SKILL.md` describes the workflow agents follow; `references/` holds setup/troubleshooting, counter meanings, the analysis method, Unity debug pragmas, experiment guidance and answer formats.

## Repository layout

| path | what |
|---|---|
| `.agents/skills/renderdoc-gpu/` | the skill (SKILL.md, CLI in `scripts/`, references) |
| `scripts/rdjob.py` | runs inside RenderDoc's Python (3.6-compatible): extraction, counters, state, shaders, experiments |
| `scripts/lib/*.mjs` | host discovery, job runner, cache model, queries, compare, find-source, Nsight Perf setup, HTML report |
| `tests/rdgpu.test.mjs` | `node --test tests/rdgpu.test.mjs` (offline); set `RDGPU_TEST_CAPTURE=<.rdc>` to also run a live replay test |
| `tests/fixtures/legacy-hdrp/` | real HDRP frame export (Event Browser TXT + NVIDIA counters CSV) for `import` |
| `dev/gl-scene/scene.py` | synthetic URP-like OpenGL frame used to produce test captures (runs on Mesa llvmpipe under Xvfb) |
| `dev/fixtures/MiniUnityProject/` | tiny Unity-like project for `find-source` tests |
