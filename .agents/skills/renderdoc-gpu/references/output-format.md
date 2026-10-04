# Answer formats

Language: the user's. Units always (ms, %, px, MB). EIDs and marker names exactly as in tool output so the user can find them in RenderDoc.

## A. "What is slow in this frame?"

```
**Answer.** Most of the frame (58%, 375 ms of 647 ms replay time) is DrawOpaqueObjects, and 88% of that is a single draw: HeroStatue (EID 540, 330 ms) — 240k triangles that cover only ~22k pixels.

| where | EID | ms | % frame | key counters |
|---|---|---|---|---|
| DrawOpaqueObjects | 237 | 374.9 | 58% | 37 draws, 281k ps |
| └ HeroStatue draw | 540 | 329.7 | 51% | 720k verts, 240k tris, 22k ps (0.1 px/tri) |
| Bloom (4 downsamples) | 567 | 117.5 | 18% | 306k ps, 9×9 taps (`_BlurTaps`=9) |

**Confidence.** HeroStatue dominates: confirmed. Vertex/triangle load is the reason: likely (0.1 pixel per triangle, PS cost per pixel normal) — confirm with a LOD test.
**Next steps.** 1) Check the statue's LOD group / mesh density in Unity. 2) `experiment` is not applicable (geometry), test by swapping the mesh. 3) Bloom: try 5×5 taps (`experiment`, est. −60%).
```

## B. Regression ("why did X get slower?")

Lead with the work change, then cost per item, then efficiency:

```
**Answer.** PostProcessing > Bloom went from 117 to 647 ms (+450%) with identical pixel counts and identical shader code: the blur tap count constant changed from 9 to 25 (`_BlurTaps`, `draw` EID 575 in both), i.e. 81 → 625 fetches per pixel.
| metric | before | after | Δ |
...
**Not established:** why the constant changed (project setting/asset) — check the Bloom settings in the Volume profile.
```

## C. Experiment report

```
**Result.** Reducing bloom taps 25→9 in replay: EID 575 65.4 → 8.5 ms (−87% vs recompiled original), all 4 bloom draws −87%, frame −20%. Image differs on 12% of texels of the half-res bloom target (softer glow) — see images/taps9_eid575.png.
**Edited code** (diff): `int half_ = _BlurTaps/2;` → `int half_ = 4;`
**Port to project:** Bloom.shader line ~42 or the Volume's tap setting.
```

## D. Blocked / partial

Say what you could do with what you have, then exactly what is missing and who must do it:

```
NVIDIA counters are unavailable (Nsight Perf SDK not installed), so cache/stall analysis is not possible. Timing and work counters are enough for the answer above.
To enable: download the SDK at https://developer.nvidia.com/nsight-perf-sdk/get-started (NVIDIA login) and tell me the file path — I'll install it (`setup-nvperf --from <path>`).
```

## Clarifying questions

One message, numbered, each with a default you will use if they don't answer:

```
Before I dig in:
1. Which capture is the baseline? (default: frame_0412.rdc, the older one)
2. Path to the Unity project for shader source lookup? (default: skip; I'll use embedded source/disassembly)
```

Don't ask about things the tools can find (which pass is slowest, which shader, which counter exists).
