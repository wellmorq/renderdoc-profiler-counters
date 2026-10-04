// Compact text tables and number formatting tuned for agent consumption.

export function fmtNum(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  if (typeof v !== 'number') return String(v);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (Number.isInteger(v)) return String(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(Math.min(digits, 2));
  return v.toPrecision(digits);
}

export function fmtMs(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  if (v === 0) return '0';
  if (Math.abs(v) >= 10) return v.toFixed(2);
  if (Math.abs(v) >= 0.1) return v.toFixed(3);
  return v.toFixed(4);
}

export function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return (v >= 0 ? '' : '') + v.toFixed(digits) + '%';
}

export function fmtDelta(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return '-';
  if (a === 0) return b === 0 ? '0%' : 'new';
  const d = ((b - a) / Math.abs(a)) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(Math.abs(d) < 10 ? 1 : 0) + '%';
}

export function trunc(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  const keep = n - 1;
  const head = Math.ceil(keep * 0.6);
  return s.slice(0, head) + '…' + s.slice(s.length - (keep - head));
}

// rows: array of arrays; align: string like 'lrrr' (l/r per column)
export function table(header, rows, align = '') {
  const all = [header, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const w = header.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  const line = (r) => r.map((c, i) => {
    const a = align[i] || (i === 0 ? 'l' : 'r');
    return a === 'r' ? c.padStart(w[i]) : c.padEnd(w[i]);
  }).join('  ').trimEnd();
  return [line(all[0]), ...all.slice(1).map(line)].join('\n');
}

export function bar(frac, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(n) + '·'.repeat(width - n);
}
