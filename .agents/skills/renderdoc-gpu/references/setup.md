# Setup and troubleshooting

## How the CLI talks to RenderDoc

Every live step runs `scripts/rdjob.py` inside RenderDoc's own Python. Two hosts:

| Host | How | When |
|---|---|---|
| `qrenderdoc` (default) | `qrenderdoc --python rdjob.py` — the installed RenderDoc UI runs the script headless and exits; no window | Any normal RenderDoc install (Windows installer, Linux package). Nothing to build. |
| `python` | a standalone interpreter imports the `renderdoc` module | Only when `RENDERDOC_PYTHON_PATH` points at a folder containing `renderdoc.pyd`/`renderdoc.so` built for that exact Python version (e.g. by `rdc setup-renderdoc` from rdc-cli, or a source build) |

`doctor` shows which host is used. Force one with `--host qrenderdoc|python` or `RDGPU_HOST`.

RenderDoc lookup order: `RDGPU_RENDERDOC` (install dir or exe) → `RENDERDOC_DIR` → Windows registry `.rdc` association → `C:\Program Files\RenderDoc` → PATH. Linux: `/usr/bin/qrenderdoc`, `/opt/renderdoc*/bin`, PATH. Get RenderDoc from https://renderdoc.org/builds (any recent 1.x; 1.30+ recommended).

The capture is replayed on the local GPU: it needs the same graphics API (a D3D11 capture replays only on Windows) and a GPU/driver that can create the same device. Counters come from the **replay** GPU.

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
| `qrenderdoc started but did not run the script ... waiting on a dialog` | First RenderDoc launch shows "Anonymous Analytics"; with "manually verify" selected it asks monthly. User opens RenderDoc once, answers, closes it. |
| `RenderDoc exited ... without writing a result` | Replay crashed. The error includes the tail of the newest RenderDoc log (`%TEMP%\RenderDoc\*.log`, `/tmp/RenderDoc/*.log`). Retry once; try `--no-state` (fewer replays); update GPU driver/RenderDoc. |
| `Capture cannot be replayed on this machine` | Wrong API/platform/GPU. Analyse it on the machine where it was captured (same API, compatible GPU). |
| `DEGRADED replay` in summary | RenderDoc fell back (e.g. different GPU). Timings and counters are less trustworthy; say so. |
| Job timed out | `--timeout <sec>` (default 1800). Big frames: `open --state-limit 2000` or `--no-shaders`. |
| Counter "missing" in a fetch | Not offered for this GPU/API/SDK version. `metrics <rdc> <part of name>` lists what exists. |
| Wrong `.rdc` cache reused | The cache is keyed by file size+mtime. `open --force` re-extracts. `RDGPU_CASES=<dir>` stores caches outside the capture folder. |

## Optional: rdc-cli for interactive debugging

https://github.com/BANANASJIM/rdc-cli (MIT) is a broader RenderDoc CLI (pixel history, shader debugging, mesh/buffer export, VFS browsing) with a daemon that keeps a capture open. On Windows it builds the RenderDoc Python module from source (`uv tool install rdc-cli`, `rdc setup-renderdoc` — needs Git and Visual Studio Build Tools). Once built, point this skill at the same module with `RENDERDOC_PYTHON_PATH=<rdc's renderdoc dir>` and `RDGPU_PYTHON=<the python it was built for>` if you prefer the `python` host. This skill does not require it.
