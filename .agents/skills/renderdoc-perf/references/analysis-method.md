# Explaining a pass regression

Use this method for questions such as "Why did AreaLight become slower?". It is a reasoning guide, not a fixed diagnosis table.

## Start with a comparable region

Identify the intended marker or pass in both captures. If several independent nodes match, compare their non-overlapping aggregate and list the largest contributors. Do not treat capture-local EIDs as stable identities. Treat a path match as uncertain when marker order or workload topology changed.

Before making a causal claim, check whether the captures appear comparable: same intended scene/camera, resolution, API/GPU, marker structure, and counter set. Report observable structural mismatches. The exports usually cannot prove that the external workload was controlled.

Treat a focused before/after topology warning as a comparison warning, not as a harmless naming detail: added, removed, or moved matching roots mean the aggregates cover different event sets. Confirm the intended regions before attributing the delta to implementation cost.

## Explain the change in three layers

### 1. More work

Look for changes in draw/event count, input vertices and primitives, rasterized primitives, samples passed, and VS/PS/CS invocations.

Example: "The pass is slower because it processes about twice as many vertices; the cost per vertex is nearly unchanged."

### 2. More work per item

Compare instructions, memory bytes, and duration normalized by the relevant invocation or primitive count. Pick the denominator that matches the dominant stage and state when it is only an approximation.

The focused query may show a mixed invocation ratio using region-wide instructions or bytes divided by the sum of VS, PS, and CS invocations. Treat that only as a broad workload-normalization clue. Do not describe it as vertex, pixel, or compute cost unless the region and available stage counters justify that denominator. Do not divide whole-region DRAM traffic by vertex count and call the result vertex-fetch cost.

Example: "Pixel count is stable, but shader instructions grew 55%, so each shaded pixel is doing more computation."

NVIDIA `sm__inst_executed` is a hardware instruction metric, not necessarily a one-to-one source instruction count. Relative changes are more reliable than literal source-level interpretations.
Do not divide an `.avg` instruction counter by warp size or shader invocations unless the NVIDIA definition explicitly establishes that denominator. An `.avg` suffix alone does not mean "per warp" or "per thread".

### 3. Less efficient execution

Only after workload amount and per-item cost, examine cache hit rates, warp stalls, register pressure, shared-memory conflicts, and backend activity.

Translate the term:

- `long scoreboard`: warps wait for data from L1TEX-backed memory operations.
- `lg_throttle`: the local/global memory instruction queue is saturated.
- `tex_throttle`: the texture instruction queue is saturated.
- `math_pipe_throttle`: a math execution pipeline is oversubscribed.
- `short scoreboard`: dependencies on MIO/shared-memory or special-function work delay progress.
- `not_selected`: eligible warps exist but another warp was scheduled; high values alone are not a problem.

Example: "The amount of work is stable, but more warps wait for texture/global-memory data. L1 hit rate fell and long-scoreboard stalls rose."

## Evidence discipline

Use explicit before/after values. Prefer at least two mutually consistent signals for a causal hypothesis. A single counter or correlation is rarely enough.

Distinguish:

- confirmed observation: directly present or derived from the exports;
- supported explanation: several counters point to the same workload mechanism;
- unproven possibility: requires pipeline state, shader source, resource metadata, or a controlled recapture.

Do not claim "more vertex attributes" from vertex count alone. A rise in bytes per vertex supports heavier vertex data, but exact attribute count and layout require pipeline-state evidence. Likewise, counters alone do not identify the shader keyword or source edit that caused an instruction increase.

When a preferred `.sum` counter is absent and only an `.avg` variant exists, compare that average as its own signal. Do not normalize an average counter again as though it were a region-wide total.

An event with `counterRowCount: 0` is not measured. Its missing metric keys are unknown, not zeros, and it must not be used to claim that a workload or stall disappeared. For measured records, omitted metric keys are sparse encoded numeric zeros.

The prepared summary and focused query normalize recognized RenderDoc duration units (`s`, `ms`, `µs`/`us`, `ns`) to milliseconds. The raw duration counter stored in NDJSON keeps the CSV unit; apply `durationToMs` when inspecting it directly.

For generated parent markers, `.avg`, `.pct`, and `.ratio` values are duration-weighted estimates across descendant actions. They are useful summaries, but they are not exact marker-wide recomputations. A true aggregate hit rate, stall percentage, or similar ratio requires the metric's numerator and denominator; otherwise inspect the descendant range and describe the marker value as an estimate.

## Finish with discriminating checks

Suggest two or three checks tied to the leading explanation, for example:

- compare the shader variant and instruction count for the matched draw;
- hold light count and screen coverage constant;
- inspect vertex input layout when bytes per vertex increased;
- disable one texture/sample path and repeat a matched capture;
- collect a missing stage-specific counter needed to separate two explanations.

Avoid generic optimization lists.
