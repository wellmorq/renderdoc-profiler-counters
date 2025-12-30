(() => {
  'use strict';

  // ======================
  // ShaderXray (plugin tab)
  // ======================
  const METRICS = {
    GPU_TIME_NS: ['gpu__time_duration.sum', 'gpu__time_duration.avg'],
    GPU_ACTIVE_NS: ['gpu__time_active.sum', 'gpu__time_active.avg'],
    SAMPLES_PASSED: 'Samples Passed',
    PS_INVOCATIONS: 'PS Invocations',
    CS_INVOCATIONS: 'CS Invocations',
    VS_INVOCATIONS: 'VS Invocations',
    DRAM_READ_BYTES: ['dram__bytes_op_read.sum', 'dram__bytes_op_read.avg'],
    DRAM_WRITE_BYTES: ['dram__bytes_op_write.sum', 'dram__bytes_op_write.avg'],
    L1_HIT_PCT: [
      'l1tex__t_sector_hit_rate.avg.pct',
      'l1tex__average_t_sector_lookup_hit.avg.pct',
      'l1tex__t_sector_pipe_tex_hit_rate.avg.pct',
      'l1tex__t_sector_pipe_tex_mem_texture_hit_rate.avg.pct',
      'l1tex__average_t_sector_hit_rate_realtime.avg.pct',
    ],
    L2_HIT_PCT: [
      'lts__t_sector_hit_rate.avg.pct',
      'lts__average_t_sector_hit_rate_realtime.avg.pct',
      'lts__average_t_sector_lookup_hit.avg.pct',
    ],
    INST_EXECUTED: ['sm__inst_executed.sum', 'sm__inst_executed.avg'],
    REGS_3D_PCT: ['tpc__average_registers_per_thread_shader_3d.avg.pct', 'tc__average_registers_per_thread_shader_3d.avg.pct'],
    REGS_PS_PCT: ['tpc__average_registers_per_thread_shader_ps.avg.pct', 'tc__average_registers_per_thread_shader_ps.avg.pct'],
    REGS_VS_PCT: ['tpc__average_registers_per_thread_shader_vtg.avg.pct', 'tc__average_registers_per_thread_shader_vs.avg.pct'],

    STALL_LONG_SCOREBOARD: 'smsp__warp_issue_stalled_long_scoreboard_per_warp_active.avg.pct',
    STALL_SHORT_SCOREBOARD: 'smsp__warp_issue_stalled_short_scoreboard_per_warp_active.avg.pct',
    STALL_TEX_THROTTLE: 'smsp__warp_issue_stalled_tex_throttle_per_warp_active.avg.pct',
    STALL_MATH_THROTTLE: 'smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active.avg.pct',
    STALL_BRANCH_RESOLVING: 'smsp__warp_issue_stalled_branch_resolving_per_warp_active.avg.pct',
    STALL_BARRIER: 'smsp__warp_issue_stalled_barrier_per_warp_active.avg.pct',
    STALL_NOT_SELECTED: 'smsp__warp_issue_stalled_not_selected_per_warp_active.avg.pct',
    STALL_MIO_THROTTLE: 'smsp__warp_issue_stalled_mio_throttle_per_warp_active.avg.pct',
    STALL_MEMBAR: 'smsp__warp_issue_stalled_membar_per_warp_active.avg.pct',
    STALL_MISC: 'smsp__warp_issue_stalled_misc_per_warp_active.avg.pct',
  };

  const REQUIRED = [
    METRICS.GPU_TIME_NS, METRICS.GPU_ACTIVE_NS, METRICS.SAMPLES_PASSED, METRICS.PS_INVOCATIONS, METRICS.CS_INVOCATIONS,
    METRICS.DRAM_READ_BYTES, METRICS.DRAM_WRITE_BYTES, METRICS.L1_HIT_PCT, METRICS.L2_HIT_PCT,
    METRICS.INST_EXECUTED, METRICS.REGS_3D_PCT, METRICS.REGS_PS_PCT, METRICS.REGS_VS_PCT,
    METRICS.STALL_LONG_SCOREBOARD, METRICS.STALL_SHORT_SCOREBOARD, METRICS.STALL_TEX_THROTTLE, METRICS.STALL_MATH_THROTTLE,
  ];

  const CFG = { TOP_STALLS_TO_SHOW: 6, LOW_CACHE_PCT: 60, HIGH_REGS_PCT: 80 };
  const TAB_ID = 'shader-xray', TAB_NAME = 'ShaderXray', TAB_ORDER = 2;

  function quantile(arr, q) {
    if (!arr || arr.length === 0) return NaN;
    const a = Array.from(arr).sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const base = Math.floor(pos); const rest = pos - base;
    if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
    return a[base];
  }
  const median = (arr) => quantile(arr, 0.5);

  const STALL_INFO = [
    { key: 'STALL_LONG_SCOREBOARD', label: 'Long Scoreboard (Latency)', icon: '🐌', why: 'Waiting for high-latency operation (DRAM, Texture).', fixes: ['Minimize dependent texture fetches.', 'Improve texture cache locality.', 'Check for low L1/L2 cache hit rates.', 'Reduce register pressure to hide latency.'] },
    { key: 'STALL_SHORT_SCOREBOARD', label: 'Short Scoreboard (Dependency)', icon: '🔗', why: 'Waiting for short-latency operation (L1, Shared, MIO).', fixes: ['Reduce Read-After-Write dependencies.', 'Optimize shared memory patterns (bank conflicts).'] },
    { key: 'STALL_TEX_THROTTLE', label: 'Texture Throughput', icon: '🖼️', why: 'Texture Units are fully saturated.', fixes: ['Reduce number of texture samples.', 'Use simpler filtering (Bilinear).', 'Use smaller texture formats.'] },
    { key: 'STALL_MATH_THROTTLE', label: 'Math/ALU Throughput', icon: '➗', why: 'ALU pipes are fully saturated.', fixes: ['Replace expensive math with approximations.', 'Move invariant math to Vertex Shader.', 'Use half-precision (FP16) where possible.'] },
    { key: 'STALL_BRANCH_RESOLVING', label: 'Branch Divergence', icon: '🔀', why: 'Stalled waiting for branch reconvergence.', fixes: ['Reduce dynamic branching.', 'Group threads by condition.', 'Use branchless logic (step, lerp).'] },
    { key: 'STALL_BARRIER', label: 'Barrier / Sync', icon: '🛑', why: 'Waiting at a synchronization barrier.', fixes: ['Reduce frequency of barriers.', 'Balance work between threads in group.'] },
    { key: 'STALL_NOT_SELECTED', label: 'Occupancy / Idle', icon: '💤', why: 'Warp ready but not selected. Often Occupancy limits.', fixes: ['Reduce Register Pressure! (High regs = fewer active warps).', 'Reduce Shared Memory usage.'] },
    { key: 'STALL_MIO_THROTTLE', label: 'MIO Pipe', icon: '📦', why: 'Memory I/O pipe saturated.', fixes: ['Reduce global memory stores.', 'Avoid heavy use of atomics.', 'Simplify attribute interpolation.'] },
    { key: 'STALL_MEMBAR', label: 'Memory Barrier', icon: '🚧', why: 'Waiting on a memory fence.', fixes: ['Relax memory ordering constraints.', 'Remove redundant fences.'] },
    { key: 'STALL_MISC', label: 'Misc', icon: '❓', why: 'Miscellaneous hardware stalls.', fixes: ['Profile with Nsight Graphics for deep instruction view.'] },
  ];

  function render(container, ctx) {
    container.innerHTML = '';
    const { node, agg, state, utils } = ctx;
    if (!node) { container.innerHTML = '<div style="padding:10px">Select an event.</div>'; return; }

    const headers = state.headers || [];
    const missing = REQUIRED.filter(d => !utils.resolveMetric(headers, d));
    if (missing.length > 0) {
        container.innerHTML = `<div style="padding:10px;background:#1b1b1b;border:1px solid #444;border-radius:6px"><b>Missing counters:</b><pre style="margin-top:8px">${missing.map(d=>Array.isArray(d)?d[0]:d).join('\n')}</pre></div>`;
        return;
    }

    const timeNs = utils.getAgg(agg, headers, METRICS.GPU_TIME_NS);
    const activeNs = utils.getAgg(agg, headers, METRICS.GPU_ACTIVE_NS);
    const samples = utils.getAgg(agg, headers, METRICS.SAMPLES_PASSED);
    const ps = utils.getAgg(agg, headers, METRICS.PS_INVOCATIONS);
    const cs = utils.getAgg(agg, headers, METRICS.CS_INVOCATIONS);
    const vs = utils.getAgg(agg, headers, METRICS.VS_INVOCATIONS);
    const dramBytes = utils.getAgg(agg, headers, METRICS.DRAM_READ_BYTES) + utils.getAgg(agg, headers, METRICS.DRAM_WRITE_BYTES);
    const l1Hit = utils.getAgg(agg, headers, METRICS.L1_HIT_PCT);
    const l2Hit = utils.getAgg(agg, headers, METRICS.L2_HIT_PCT);
    const inst = utils.getAgg(agg, headers, METRICS.INST_EXECUTED);
    const regs3d = utils.getAgg(agg, headers, METRICS.REGS_3D_PCT);
    const regsPs = utils.getAgg(agg, headers, METRICS.REGS_PS_PCT);
    const regsVs = utils.getAgg(agg, headers, METRICS.REGS_VS_PCT);

    const isCompute = cs > 0 && ps === 0;
    const nsPerSample = utils.safeDiv(timeNs, samples, NaN);
    const instPerSample = utils.safeDiv(inst, samples, NaN);

    const stalls = STALL_INFO.map(s => ({ ...s, value: utils.getAgg(agg, headers, METRICS[s.key]) })).sort((a,b) => b.value - a.value);
    const dominant = stalls[0] || null;

    let boundTitle = 'Balanced', boundIcon = '⚖️', confidence = 0.0;
    const reasoning = [], tips = [];

    if (dominant && dominant.value > 5.0) {
        boundTitle = dominant.label; boundIcon = dominant.icon; confidence = utils.clamp01(dominant.value / 50.0); 
        reasoning.push(`<b>${dominant.label}</b> accounts for <b>${dominant.value.toFixed(1)}%</b> of stall time.`);
        reasoning.push(dominant.why);
        if (dominant.key === 'STALL_LONG_SCOREBOARD') {
            if (l1Hit < CFG.LOW_CACHE_PCT || l2Hit < CFG.LOW_CACHE_PCT) reasoning.push(`Low cache hit rates: L1 (${utils.fmtPct(l1Hit)}) / L2 (${utils.fmtPct(l2Hit)}).`);
        } else if (dominant.key === 'STALL_NOT_SELECTED' && (regsPs > CFG.HIGH_REGS_PCT || regs3d > CFG.HIGH_REGS_PCT)) {
            reasoning.push(`High Register Pressure (${utils.fmtPct(Math.max(regsPs, regs3d))}) limits occupancy.`);
            tips.push('Use `half` precision to save registers.');
        }
        dominant.fixes.forEach(f => tips.push(f));
    }

    const root = document.createElement('div');
    root.style.fontFamily = 'var(--font-family)'; root.style.padding = '10px';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--panel-bg); border-left:6px solid var(--accent-color); border-radius:4px; padding:16px; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.2)';
    const cardHeader = document.createElement('div'); cardHeader.style.display = 'flex'; cardHeader.style.alignItems = 'center'; cardHeader.style.gap = '12px';
    const iconEl = document.createElement('div'); iconEl.textContent = boundIcon; iconEl.style.fontSize = '24px';
    const titleCol = document.createElement('div'); titleCol.style.flex = '1';
    const titleText = document.createElement('div'); titleText.textContent = boundTitle; titleText.style.fontSize = '18px'; titleText.style.fontWeight = '700';
    const confRow = document.createElement('div'); confRow.style.display = 'flex'; confRow.style.alignItems = 'center'; confRow.style.gap = '10px'; confRow.style.fontSize = '12px'; confRow.style.opacity = '0.8'; confRow.style.marginTop = '4px';
    const confBar = document.createElement('div'); confBar.style.cssText = 'width:100px; height:6px; background:rgba(128,128,128,0.3); border-radius:3px; overflow:hidden';
    const confFill = document.createElement('div'); confFill.style.cssText = `width:${confidence*100}%; height:100%; background:${confidence>0.7?'#4caf50':(confidence>0.4?'#ff9800':'#f44336')}`;
    confBar.appendChild(confFill); confRow.innerHTML = `<span>Confidence: ${(confidence*100).toFixed(0)}%</span>`; confRow.appendChild(confBar);
    titleCol.appendChild(titleText); titleCol.appendChild(confRow); cardHeader.appendChild(iconEl); cardHeader.appendChild(titleCol); card.appendChild(cardHeader);
    if (reasoning.length > 0) {
        const rb = document.createElement('div'); rb.style.cssText = 'margin-top:12px; padding-top:12px; border-top:1px solid var(--border-color)';
        const ul = document.createElement('ul'); ul.style.cssText = 'margin:0; padding-left:20px; line-height:1.5';
        reasoning.forEach(r => { const li = document.createElement('li'); li.innerHTML = r; li.style.fontSize = '13px'; ul.appendChild(li); });
        rb.appendChild(ul); card.appendChild(rb);
    }
    root.appendChild(card);

    if (tips.length > 0) {
        const tt = document.createElement('div'); tt.style.cssText = 'font-weight:700; margin:20px 0 8px'; tt.textContent = 'Optimization Advice'; root.appendChild(tt);
        const tb = document.createElement('div'); tb.style.cssText = 'padding:12px; background:rgba(128,128,128,0.05); border-radius:6px; border:1px solid var(--border-color)';
        const ul = document.createElement('ul'); ul.style.cssText = 'margin:0; padding-left:20px';
        tips.forEach(t => { const li = document.createElement('li'); li.textContent = t; li.style.marginBottom = '6px'; ul.appendChild(li); });
        tb.appendChild(ul); root.appendChild(tb);
    }

    const addMetric = (l, v, d) => {
        const name = utils.resolveMetric(headers, d);
        let val = 0, max = 1;
        if (name && state.counterMinMax[name]) { val = agg[name] || 0; max = state.counterMinMax[name].max || 1; }
        root.appendChild(utils.createMetricRow(l, v, utils.createBar(val, max, '#777')));
    };

    const et = document.createElement('div'); et.style.cssText = 'font-weight:700; margin:15px 0 8px'; et.textContent = 'Key Metrics'; root.appendChild(et);
    addMetric('GPU time', utils.fmtNs(timeNs), METRICS.GPU_TIME_NS);
    addMetric('Active', utils.fmtNs(activeNs), METRICS.GPU_ACTIVE_NS);
    addMetric('Samples', utils.fmtInt(samples), METRICS.SAMPLES_PASSED);
    addMetric('Invocations', utils.fmtInt(isCompute ? cs : ps), isCompute ? METRICS.CS_INVOCATIONS : METRICS.PS_INVOCATIONS);
    addMetric('L1 Hit', utils.fmtPct(l1Hit), METRICS.L1_HIT_PCT);
    addMetric('L2 Hit', utils.fmtPct(l2Hit), METRICS.L2_HIT_PCT);

    const dt = document.createElement('div'); dt.style.cssText = 'font-weight:700; margin:20px 0 8px'; dt.textContent = 'Derived & Registers'; root.appendChild(dt);
    const db = document.createElement('div'); db.style.cssText = 'display:flex; flex-direction:column; border-radius:6px; overflow:hidden';
    const addKV = (k, v) => db.appendChild(utils.createMetricRow(k, v, ""));
    addKV('ns / sample', utils.isNumber(nsPerSample) ? `${nsPerSample.toFixed(1)} ns` : 'n/a');
    addKV('Inst / sample', utils.isNumber(instPerSample) ? utils.fmtInt(instPerSample) : 'n/a');
    addKV('DRAM traffic', utils.fmtBytes(dramBytes));
    addKV('DRAM BW', utils.fmtGBps(dramBytes, timeNs));
    addKV('Registers (Used)', utils.fmtPct(isCompute ? regs3d : regsPs));
    addKV('Registers (VS/VTG)', utils.fmtPct(regsVs));
    root.appendChild(db);

    const st = document.createElement('div'); st.style.cssText = 'font-weight:700; margin:20px 0 8px'; st.textContent = 'Warp Stall Breakdown (Top 6)'; root.appendChild(st);
    stalls.slice(0, CFG.TOP_STALLS_TO_SHOW).forEach(s => {
        if (utils.isNumber(s.value)) root.appendChild(utils.createMetricRow(s.label, utils.fmtPct(s.value), utils.createBar(s.value, 100, '#777')));
    });

    container.appendChild(root);
  }

  PluginManager.register({ id: TAB_ID, name: TAB_NAME, description: 'Stall-based shader bottleneck analysis.', order: TAB_ORDER, render });
})();
