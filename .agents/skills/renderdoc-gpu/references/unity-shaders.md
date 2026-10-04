# Unity shaders in RenderDoc captures

## Capturing from Unity

- Editor: right-click the Game (or Scene) view tab → **Load RenderDoc**, then press the RenderDoc button in the view toolbar. Or start the editor with `-load-renderdoc`. Player builds: launch the player through RenderDoc (Launch Application) and press F12/PrintScreen.
- Editor captures contain editor UI work (`GUI.*`, `UIR.DrawChain`, `EditorLoop`); focus on the camera markers (`Camera.Render`, `UniversalRenderPipeline.RenderSingleCamera...`, `HDRenderPipeline::Render <camera>`).
- Typical URP markers: `MainLightShadow`, `AdditionalLightsShadow`, `DepthPrepass`/`CopyDepth`, `DrawOpaqueObjects`, `DrawSkybox`, `DrawTransparentObjects`, `Bloom`, `UberPost`, `FinalBlit`. HDRP: `RenderDeferredLighting*`, `Contact Shadows`, `Render SSR`, `AmbientOcclusion`, `PostProcessing`, `TemporalAntialiasing`. Per-object markers like `RenderLoop.Draw` / `DrawSRPBatcher` wrap the actual API draws.

## Embedding shader source: debug pragmas

Without debug info a D3D11/D3D12/Vulkan capture only has bytecode → RenderDoc shows disassembly. To get HLSL source in the capture (and to edit/recompile it with `source` + `experiment`), add to the shader's `HLSLPROGRAM`/`CGPROGRAM` block:

```hlsl
#pragma enable_d3d11_debug_symbols   // debug info for D3D11, D3D12, Vulkan (and consoles); ALSO disables optimisation
```

Related pragmas:
- `#pragma skip_optimizations d3d11 vulkan` — optimisation off for the listed APIs only (no symbols).
- `#pragma use_dxc` — compile with DXC (DXIL/SPIR-V) instead of FXC; changes codegen and therefore timings.

Many shaders at once: put the pragma in one file and include it with pragmas enabled:

```hlsl
// Assets/Shaders/DebugPragmas.hlsl
#pragma enable_d3d11_debug_symbols

// in each shader's HLSLPROGRAM:
#include_with_pragmas "Assets/Shaders/DebugPragmas.hlsl"
```
Comment the pragma out in that one file to turn it off everywhere (needs the Caching Shader Preprocessor, default in recent Unity).

Package shaders (URP/HDRP live in `Library/PackageCache/…`, read-only): embed the package (copy it into `Packages/`) before editing, or test edits in RenderDoc only (`experiment`).

Shader Graph: open the graph's generated code (**View Generated Shader**), save it as a `.shader`, add the pragma, assign it to a test material.

## Consequences for performance work

- Debug-symbol shaders are compiled **without optimisation** (`/Od` in `shader` flags). Their timings in the capture are pessimistic, sometimes several times slower. `summary`/`shader` flag them.
- Options: (a) capture once with symbols to read and edit the code, and once without to measure; (b) in `experiment`, recompile everything optimised: `--flags-remove /Od --flags-add /O3` (applies to the `original` row too, so the comparison stays fair). DXC flags use `-Od`/`-O3` — copy the exact token from `captured compile flags`.
- The source embedded by Unity is the preprocessed variant actually compiled (keywords resolved, includes expanded or listed as separate files). Edits in `experiment` affect only this capture's replay; port a successful change to the real `.shader`/`.hlsl` yourself and recapture.

## Finding the project source

1. `shader <rdc> <id>` → cbuffer names (`UnityPerMaterial` members are the material properties: `_BaseColor`, `_BaseMap_ST`, …), texture names, entry point.
2. `find-source <rdc> <id> --project <Unity project root>` scans `Assets/`, `Packages/` and `Library/PackageCache/` for `.shader/.hlsl/.cginc/.compute/.shadergraph` and ranks files by rare identifiers. Engine-wide names (`unity_ObjectToWorld`, `_Time`, …) are ignored.
3. Material properties declared in `Properties {}` + `CBUFFER_START(UnityPerMaterial)` identify the `.shader`; `#include` files that declare the cbuffer may rank higher — the owning shader includes them.
4. Confirm by comparing a distinctive expression (constant, loop bound, texture name) between the disassembly/embedded source and the candidate file. State the confidence.

## Keywords / variants

RenderDoc doesn't know Unity keywords. Infer the variant from what is present (e.g. `_ADDITIONAL_LIGHTS` loops, shadow sampler usage, normal-map fetch). Unity's Frame Debugger shows the keywords for a draw if you need certainty — ask the user to check it there.
