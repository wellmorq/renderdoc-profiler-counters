---
name: renderdoc-perf
description: Analyze RenderDoc Event Browser TXT and Performance Counter CSV exports from a directory, build a searchable event graph and local HTML report, and answer plain-language GPU performance questions including before/after pass regressions.
metadata:
  audience: graphics-engineers
  workflow: renderdoc-performance
---

# RenderDoc performance analysis

Use this skill when the user points at a directory containing one RenderDoc events TXT plus one counters CSV, or two pairs for before/after comparison. The directory defaults to the current working directory.

Require Node.js 18+ and local file read/write access. If either capability is unavailable, explain the limitation and do not pretend the report was generated.

## Prepare the case

Run:

```text
node <skill-directory>/scripts/prepare.mjs [directory]
```

The command prints JSON containing `caseDir`, `report`, `manifest`, and `guide`. Read the generated `model-guide.md` and `manifest.json`. The generated case is content-addressed, so unchanged inputs are reused.

If the user did not ask a question, report what was discovered, validation warnings, and the clickable path to `report.html`. Stop after saying the case is ready for follow-up questions.

## Investigate a question

For a named pass or marker, obtain a focused comparison first:

```text
node <skill-directory>/scripts/query.mjs <caseDir> <pass-or-marker-name>
```

Search the generated `capture-*.ndjson` files when the focused output is not enough. Each line is one searchable graph node with its marker path, EID, scope, counters, and aggregation provenance. Metric objects are sparse: a missing key listed in that capture's manifest headers means numeric zero; a counter absent from the headers was not exported. Raw source filenames remain in `manifest.json`.

If the focused table omits a signal, search the NDJSON and manifest headers for another exported variant before concluding that the work did not change. Prefer region totals such as `.sum` for per-invocation normalization; compare `.avg` variants directly and do not treat them as totals.

Read [references/analysis-method.md](references/analysis-method.md) for causal comparison and answer quality. Search [references/nvidia-counters.json](references/nvidia-counters.json) by the exact counter name or its base prefix whenever NVIDIA counter semantics affect the conclusion.

## Answer contract

Answer in the user's language. Lead with the concrete workload explanation, then show the counters that support it.

- Prefer: "The pass shades 42% more pixels, while instructions per pixel are unchanged."
- Avoid leading with: "ROP-bound", "vertex-fetch-bound", or a stall name without explaining the work it represents.
- Separate more work, more work per item, and less efficient execution.
- Quantify before/after values and normalized values where the inputs support them.
- Treat automatic event matching and correlations as evidence, not causal proof.
- Say exactly what cannot be established from TXT+CSV. Do not infer vertex attributes, shader variants, texture count, or source-code changes unless the data contains that evidence.
- End with two or three targeted checks that distinguish the leading explanations.

The deterministic scripts own parsing, joining, aggregation, graph construction, and report generation. They do not own the performance conclusion. Use the model's file search and reasoning for questions not anticipated by the generated summaries.
