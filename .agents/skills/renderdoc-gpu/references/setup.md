# Setup and troubleshooting

## Backends

Every live step runs `scripts/rdjob.py` inside RenderDoc's Python API. Three hosts, picked in this order (override: `--host`, `RDGPU_HOST`, or `"host"` in the config):

| Host | How | Notes |
|---|---|---|
| `rdc` (preferred) | [rdc-cli](https://github.com/BANANASJIM/rdc-cli) daemon per capture; our jobs run in it via `rdc script` | Capture stays loaded between commands; the agent can also use rdc's own tools (`rdc --session <name> debug pixel …`, `pixel`, `pipeline`, `mesh`, `cbuffer`). Needs RenderDoc's Python module **built locally** by `rdc setup-renderdoc`. |
| `qrenderdoc` (fallback) | `qrenderdoc --python rdjob.py` of an installed RenderDoc, headless | Nothing to build; one capture load per command unless `session` is used; no rdc tools. |
| `python` | a standalone interpreter + `RENDERDOC_PYTHON_PATH` | For custom builds. |

## `install` — what it does (run by the agent)

0. (Only when Node.js 18+ is missing.) `scripts/bootstrap.ps1` (Windows, run with `powershell -NoProfile -ExecutionPolicy Bypass -File …`) or `scripts/bootstrap.sh` downloads the current Node.js LTS from nodejs.org, checks it against the release's SHASUMS256.txt and unpacks it to `%LOCALAPPDATA%\rdgpu\node` (`~/.local/share/rdgpu/node`). Nothing is added to PATH and no admin rights are needed; it prints the full `node` path to use, then runs `install`. An older system Node is left alone (the portable copy is used instead). Behind a proxy that blocks nodejs.org, install Node.js LTS another way (`winget install OpenJS.NodeJS.LTS`, needs an admin prompt) and run `install` directly.
1. Checks Node 18+ and git.
2. C++ toolchain: Windows → Visual Studio Build Tools with the C++ workload (detected with vswhere). Missing → `[NEED USER]` with the command for the user (admin/UAC):
   `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`. Linux → cmake, ninja, g++, bison, autotools, X11/GL dev packages.
3. Installs [uv](https://docs.astral.sh/uv/) if missing (official installer script).
4. `uv tool install rdc-cli` (puts `rdc` in `~/.local/bin`, Windows `%USERPROFILE%\.local\bin`; run `uv tool update-shell` if it isn't on PATH — the CLI finds it there anyway).
5. `rdc setup-renderdoc --version <latest RenderDoc tag>` — clones RenderDoc and compiles its Python module for rdc's Python (10–40 min; needs network to github.com). Newer RenderDoc replays captures made by older versions, so the latest tag is used unless `--renderdoc-version vX.YY` is given. Output lands in `%LOCALAPPDATA%\rdc\renderdoc` (Linux `~/.local/renderdoc`).
6. `rdc doctor` must report `renderdoc-module` and `replay-support` ok (`renderdoccmd` missing is irrelevant here).
7. Writes the config (`%APPDATA%\rdgpu\config.json`, Linux `~/.config/rdgpu/config.json`): `{"host": "rdc", "rdc": "<path>"}`.
8. Nsight Perf SDK: if an NVIDIA GPU is present and the library is missing, it looks for a downloaded SDK (see below) or prints what the user must download.

`install --check` only reports. `install --renderdoc-version v1.46` pins the version. Re-running is safe: finished steps are skipped.

## Nsight Perf SDK (NVIDIA hardware counters)

RenderDoc ships without NVIDIA's counter library because its license forbids redistribution. Without it, `doctor --capture` / `summary` show `ERROR: Could not find Nsight Perf SDK library` and only generic counters exist.

RenderDoc loads it from:
- Windows: `%APPDATA%\renderdoc\plugins\nv\nvperf_grfx_host.dll`
- Linux: `~/.renderdoc/plugins/nv/libnvperf_grfx_host.so*`

`setup-nvperf` does the copy. It searches `~/Downloads`, `~/Desktop`, the current directory and home for `NVIDIA_Nsight_Perf_SDK*` zips/folders, or takes `--from <zip | extracted folder | dll>`. It reads zips itself (no unzip tool needed) and picks the x64 host library.

The download itself needs an NVIDIA developer account: https://developer.nvidia.com/nsight-perf-sdk/get-started → sign in → accept license → download the Windows (or Linux) package. An agent cannot do this; ask the user, then run `setup-nvperf --from <path>`.

Version: RenderDoc reports `ERROR: Installed version of Nsight Perf SDK library is not supported` when the DLL is older than the SDK it was built with — download the newest SDK. After installing, prepared cases need `fetch <rdc> nv-pack` (or `open <rdc> --force`).

NVIDIA counters need a supported GPU (Turing or newer for most metrics) and work on D3D11, D3D12, Vulkan and OpenGL replays. Fetching many NVIDIA metrics replays the frame several times (one pass per hardware counter group): `nv-pack` takes ~2–10× a plain replay; `nv-all` can take many minutes.

Other vendors: AMD counters (GPA) ship with RenderDoc → `fetch <rdc> amd-all` or exact names from `metrics <rdc> <filter>`. Intel and ARM similar.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `rdc could not open the capture` | Read the rdc message; `rdc doctor`; captures newer than the built module need a newer `install --renderdoc-version`; replay needs the capture's API and a compatible GPU. |
| `rdc-cli not found` / `NOT READY` in doctor | Run `install`; if the build failed, read its output (toolchain, network, antivirus locking the build dir). The qrenderdoc fallback keeps working meanwhile. |
| `qrenderdoc started but did not run the script ... waiting on a dialog` | First RenderDoc launch shows "Anonymous Analytics"; with "manually verify" selected it asks monthly. User opens RenderDoc once, answers, closes it. |
| `RenderDoc exited ... without writing a result` | Replay crashed. The error includes the tail of the newest RenderDoc log (`%TEMP%\RenderDoc\*.log`, `/tmp/RenderDoc/*.log`). Retry once; try `--no-state` (fewer replays); update GPU driver/RenderDoc. |
| `Capture cannot be replayed on this machine` | Wrong API/platform/GPU. Analyse it on the machine where it was captured (same API, compatible GPU). |
| `DEGRADED replay` in summary | RenderDoc fell back (e.g. different GPU). Timings and counters are less trustworthy; say so. |
| Job timed out | `--timeout <sec>` (default 1800). Big frames: `open --state-limit 2000` or `--no-shaders`. |
| Counter "missing" in a fetch | Not offered for this GPU/API/SDK version. `metrics <rdc> <part of name>` lists what exists. |
| Wrong `.rdc` cache reused | The cache is keyed by file size+mtime. `open --force` re-extracts. Cache root: `%LOCALAPPDATA%\rdgpu\cache` (Linux `~/.cache/rdgpu`); `RDGPU_CASES=<dir>` moves it. Deleting it is always safe. |

## qrenderdoc fallback details

Lookup order: `RDGPU_RENDERDOC` (install dir or exe) → `RENDERDOC_DIR` → Windows registry `.rdc` association → `C:\Program Files\RenderDoc` → PATH. Linux: `/usr/bin/qrenderdoc`, `/opt/renderdoc*/bin`, PATH. RenderDoc: https://renderdoc.org/builds.
