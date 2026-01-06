#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
from pathlib import Path

PREFIX_0 = 632693968
PREFIX_1 = 858015015
PREFIX_2 = 2675035495
XOR_CONST = 0x61B37980


def strhash(s: str, seed: int = 5381) -> int:
    """
    C-like djb2 hash with uint32 overflow:
      hash = hash*33 + c
    where c is each byte of the string.
    """
    h = seed & 0xFFFFFFFF
    if s is None:
        return h

    # Metric names are typically ASCII; using UTF-8 bytes matches byte-wise C hashing for ASCII.
    for b in s.encode("utf-8"):
        h = ((h << 5) + h + b) & 0xFFFFFFFF
    return h


def counter_entry(metric_name: str) -> list[int]:
    last = (XOR_CONST ^ strhash(metric_name)) & 0xFFFFFFFF
    return [PREFIX_0, PREFIX_1, PREFIX_2, last]


def render_json_like_example(counters: list[list[int]]) -> str:
    """
    Emit JSON with the exact formatting like the provided example:
    - 4-space indentation
    - each int on its own line
    - trailing newline at the end
    """
    lines: list[str] = []
    lines.append("{")
    lines.append('    "counters": [')

    if counters:
        for i, arr in enumerate(counters):
            lines.append("        [")
            for j, val in enumerate(arr):
                comma = "," if j < len(arr) - 1 else ""
                lines.append(f"            {val}{comma}")
            tail_comma = "," if i < len(counters) - 1 else ""
            lines.append(f"        ]{tail_comma}")
    lines.append("    ],")
    lines.append('    "rdocPerformanceCounterSettings": 1')
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Generate RenderDoc-like performance counter JSON from metric names."
    )
    ap.add_argument("input_txt", help="Input TXT with metric names, one per line")
    ap.add_argument("output_json", help="Output JSON path")
    args = ap.parse_args()

    inp = Path(args.input_txt)
    outp = Path(args.output_json)

    if not inp.exists():
        raise SystemExit(f"Input file not found: {inp}")

    # Read metric names: one per line, trim whitespace, skip empty lines
    names = []
    for line in inp.read_text(encoding="utf-8").splitlines():
        name = line.strip()
        if name:
            names.append(name)

    counters = [counter_entry(n) for n in names]
    out_text = render_json_like_example(counters)
    outp.write_text(out_text, encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
