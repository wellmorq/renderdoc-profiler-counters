// Counter sets. Resolved inside RenderDoc against the capture's counter catalog,
// so unknown names are reported as "missing" instead of failing.

export const PRESETS = {
  generic: { families: ['generic'], help: 'RenderDoc pipeline statistics + GPU Duration (cheap, every vendor)' },
  'nv-instructions': {
    patterns: ['^sm__inst_executed\\.(sum|avg)$', '^smsp__inst_executed_shader_(vs|ps|cs|gs|tcs|tes)\\.sum$'],
    help: 'NVIDIA executed warp instructions, total and per shader stage',
  },
  'nv-memory': {
    patterns: ['^dram__bytes_op_(read|write)\\.(sum|avg)$', '^l1tex__t_sector_hit_rate\\.avg\\.pct$',
      '^l1tex__t_sector_pipe_tex_hit_rate\\.avg\\.pct$', '^lts__t_sector_hit_rate\\.avg\\.pct$',
      '^lts__average_t_sector_hit_rate_realtime\\.avg\\.pct$'],
    help: 'NVIDIA DRAM traffic and L1/texture/L2 hit rates',
  },
  'nv-stalls': {
    patterns: ['^smsp__warp_issue_stalled_[a-z_]+_per_warp_active\\.avg\\.pct$'],
    help: 'NVIDIA warp stall reasons (% of active warp cycles)',
  },
  'nv-occupancy': {
    patterns: ['^tpc__average_registers_per_thread_shader_[a-z0-9]+\\.avg\\.(ratio|pct)$', '^sm__warps_active\\.avg\\.pct$',
      '^sm__maximum_warps_per_active_cycle_pct$'],
    help: 'NVIDIA register usage per thread / warp occupancy hints',
  },
  'nv-time': { patterns: ['^gpu__time_(duration|active)\\.sum$'], help: 'NVIDIA range duration/active time (ns)' },
  'nv-all': { families: ['nvidia'], help: 'every NVIDIA counter (hundreds; many replay passes — slow)' },
  'amd-all': { families: ['amd'], help: 'every AMD GPA counter (slow)' },
  'intel-all': { families: ['intel'], help: 'every Intel counter' },
};
PRESETS['nv-pack'] = {
  patterns: [...PRESETS['nv-time'].patterns, ...PRESETS['nv-instructions'].patterns, ...PRESETS['nv-memory'].patterns,
    ...PRESETS['nv-stalls'].patterns, ...PRESETS['nv-occupancy'].patterns],
  help: 'nv-time + nv-instructions + nv-memory + nv-stalls + nv-occupancy (default on NVIDIA)',
};

// spec: comma list of preset names, exact counter names, or re:<regex>
export function expandCounterSpec(spec) {
  const job = { names: [], families: [], patterns: [], presets: [] };
  for (const raw of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (PRESETS[raw]) {
      const p = PRESETS[raw];
      job.presets.push(raw);
      job.families.push(...(p.families || []));
      job.patterns.push(...(p.patterns || []));
    } else if (raw.startsWith('re:')) {
      job.patterns.push(raw.slice(3));
    } else {
      job.names.push(raw);
    }
  }
  return job;
}

export function presetHelp() {
  return Object.entries(PRESETS).map(([k, v]) => `  ${k.padEnd(16)} ${v.help}`).join('\n');
}
