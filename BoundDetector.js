(() => {
  'use strict';

  // =========================
  // BoundDetector (plugin tab)
  // =========================
  const METRICS = {
    GPU_TIME_NS: ['gpu__time_duration.sum', 'gpu__time_duration.avg'],
    GPU_ACTIVE_NS: ['gpu__time_active.sum', 'gpu__time_active.avg'],
    GPU_DURATION_MS: ['GPU Duration', 'GPU Duration (ms)'],
    SAMPLES_PASSED: 'Samples Passed',
    PS_INVOCATIONS: 'PS Invocations',
    VS_INVOCATIONS: 'VS Invocations',
    CS_INVOCATIONS: 'CS Invocations',
    RASTERIZED_PRIMS: 'Rasterized Primitives',
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
    REGS_3D_PCT: [
      'tpc__average_registers_per_thread_shader_3d.avg.pct',
      'tpc__average_registers_per_thread_shader_3d.avg.ratio',
      'tc__average_registers_per_thread_shader_3d.avg.pct'
    ],
  };

  const REQUIRED = [
    METRICS.GPU_TIME_NS, METRICS.GPU_ACTIVE_NS, METRICS.SAMPLES_PASSED,
    METRICS.PS_INVOCATIONS, METRICS.VS_INVOCATIONS, METRICS.CS_INVOCATIONS,
    METRICS.RASTERIZED_PRIMS, METRICS.DRAM_READ_BYTES, METRICS.DRAM_WRITE_BYTES,
    METRICS.L1_HIT_PCT, METRICS.L2_HIT_PCT, METRICS.INST_EXECUTED, METRICS.REGS_3D_PCT,
  ];

  const CFG = {
    UNDERUTIL_ACTIVE_RATIO: 0.80,
    HIGH_COST_MULT: 1.50,
    HIGH_WORK_MULT: 1.50,
    LOW_L1_HIT_PCT: 60,
    LOW_L2_HIT_PCT: 60,
    HIGH_REGS_PCT: 80,
  };

  const TAB_ID = 'bound-detector';
  const TAB_NAME = 'BoundDetector';
  const TAB_ORDER = 1;

  // Local math helpers for global stats
  function quantile(arr, q) {
    if (!arr || arr.length === 0) return NaN;
    const a = Array.from(arr).sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
    return a[base];
  }
  const median = (arr) => quantile(arr, 0.5);

  function collect(state, metricDef, utils, predicateFn) {
    const name = utils.resolveMetric(state.headers || [], metricDef);
    if (!name) return [];
    const out = [];
    state.counters.forEach((m) => {
      const v = m[name];
      if (!utils.isNumber(v)) return;
      if (predicateFn && !predicateFn(v, m)) return;
      out.push(v);
    });
    return out;
  }

  function collectDerived(state, nDef, dDef, utils, filterFn) {
    const nName = utils.resolveMetric(state.headers || [], nDef);
    const dName = utils.resolveMetric(state.headers || [], dDef);
    if (!nName || !dName) return [];
    const out = [];
    state.counters.forEach((m) => {
      const n = m[nName], d = m[dName];
      if (!utils.isNumber(n) || !utils.isNumber(d) || d <= 0) return;
      const r = n / d;
      if (!Number.isFinite(r)) return;
      if (filterFn && !filterFn(r, m)) return;
      out.push(r);
    });
    return out;
  }

  function buildMissingBlock(container, missingDefs) {
    const box = document.createElement('div');
    box.style.padding = '10px'; box.style.border = '1px solid #444'; box.style.borderRadius = '6px'; box.style.background = '#1b1b1b';
    const title = document.createElement('div');
    title.textContent = 'Missing required counters for BoundDetector'; title.style.fontWeight = '700'; title.style.marginBottom = '6px';
    box.appendChild(title);
    const list = document.createElement('pre');
    list.style.margin = '0'; list.style.whiteSpace = 'pre-wrap'; list.style.userSelect = 'text';
    list.textContent = missingDefs.map((d) => (Array.isArray(d) ? d.join(' OR ') : d)).join('\n');
    box.appendChild(list);
    container.appendChild(box);
  }

  function render(container, ctx) {
    container.innerHTML = '';
    const { node, agg, state, utils } = ctx;
    if (!node) { container.innerHTML = '<div style="padding:10px">Select an event on the timeline.</div>'; return; }

    const headers = state.headers || [];
    const missing = REQUIRED.filter(d => !utils.resolveMetric(headers, d));
    if (missing.length > 0) { buildMissingBlock(container, missing); return; }

    // Metrics for current selection
    const timeNs = utils.getAgg(agg, headers, METRICS.GPU_TIME_NS);
    const activeNs = utils.getAgg(agg, headers, METRICS.GPU_ACTIVE_NS);
    const samples = utils.getAgg(agg, headers, METRICS.SAMPLES_PASSED);
    const ps = utils.getAgg(agg, headers, METRICS.PS_INVOCATIONS);
    const vs = utils.getAgg(agg, headers, METRICS.VS_INVOCATIONS);
    const cs = utils.getAgg(agg, headers, METRICS.CS_INVOCATIONS);
    const prims = utils.getAgg(agg, headers, METRICS.RASTERIZED_PRIMS);
    const dramRead = utils.getAgg(agg, headers, METRICS.DRAM_READ_BYTES);
    const dramWrite = utils.getAgg(agg, headers, METRICS.DRAM_WRITE_BYTES);
    const dramBytes = dramRead + dramWrite;
    const l1Hit = utils.getAgg(agg, headers, METRICS.L1_HIT_PCT);
    const l2Hit = utils.getAgg(agg, headers, METRICS.L2_HIT_PCT);
    const inst = utils.getAgg(agg, headers, METRICS.INST_EXECUTED);
    const regsPct = utils.getAgg(agg, headers, METRICS.REGS_3D_PCT);

    const activeRatio = utils.clamp01(utils.safeDiv(activeNs, timeNs, 1));
    const nsPerSample = utils.safeDiv(timeNs, samples, NaN);
    const nsPerPrim = utils.safeDiv(timeNs, prims, NaN);
    const bytesPerSample = utils.safeDiv(dramBytes, samples, NaN);
    const instPerSample = utils.safeDiv(inst, samples, NaN);

    // Global baselines
    const timeMedian = median(collect(state, METRICS.GPU_TIME_NS, utils, (v) => v > 0));
    const samplesP90 = quantile(collect(state, METRICS.SAMPLES_PASSED, utils, (v) => v > 0), 0.90);
    const primsP90 = quantile(collect(state, METRICS.RASTERIZED_PRIMS, utils, (v) => v > 0), 0.90);
    const nsPerSampleMed = median(collectDerived(state, METRICS.GPU_TIME_NS, METRICS.SAMPLES_PASSED, utils, (v) => v > 0));
    const nsPerPrimMed = median(collectDerived(state, METRICS.GPU_TIME_NS, METRICS.RASTERIZED_PRIMS, utils, (v) => v > 0));
    const instPerSampleMed = median(collectDerived(state, METRICS.INST_EXECUTED, METRICS.SAMPLES_PASSED, utils, (v) => v > 0));

    // DRAM throughput baseline calculation
    const dramBWArr = [];
    const tName = utils.resolveMetric(headers, METRICS.GPU_TIME_NS);
    const rName = utils.resolveMetric(headers, METRICS.DRAM_READ_BYTES);
    const wName = utils.resolveMetric(headers, METRICS.DRAM_WRITE_BYTES);
    if (tName && rName && wName) {
      state.counters.forEach((m) => {
        const t = m[tName], r = m[rName], w = m[wName];
        if (t > 0 && utils.isNumber(r) && utils.isNumber(w)) {
          const bw = (r + w) * 1e9 / t;
          if (Number.isFinite(bw)) dramBWArr.push(bw);
        }
      });
    }
    const dramBWP90 = quantile(dramBWArr, 0.90);
    const dramBW = (timeNs > 0) ? (dramBytes * 1e9 / timeNs) : NaN;

    const isCompute = cs > 0 && ps === 0 && vs === 0;
    const isPixel = ps > 0 || samples > 0;
    const isGeometry = !isPixel && (vs > 0 || prims > 0);

    // Heuristic scoring
    let bound = 'Unknown', icon = '❓', confidence = 0.0;
    const reasoning = [];

    if (activeRatio < CFG.UNDERUTIL_ACTIVE_RATIO) {
      bound = 'GPU Idle / CPU Bound'; icon = '💤';
      confidence = utils.clamp01((CFG.UNDERUTIL_ACTIVE_RATIO - activeRatio) / CFG.UNDERUTIL_ACTIVE_RATIO);
      reasoning.push(`The GPU is active only <b>${(activeRatio*100).toFixed(0)}%</b> of the time.`);
      reasoning.push(`Waiting for the CPU, synchronization barriers, or previous commands.`);
    } else if (isCompute) {
      bound = 'Compute Shader'; icon = '🧮'; confidence = 0.50; reasoning.push('Compute Shader dispatch (CS Invocations > 0).');
      if (l1Hit < CFG.LOW_L1_HIT_PCT && dramBW > dramBWP90 * 0.8) { bound += ' (Memory)'; confidence = 0.70; reasoning.push('High bandwidth usage with low cache hits.'); }
      else if (instPerSample > instPerSampleMed * 1.5) { bound += ' (Math)'; confidence = 0.70; reasoning.push('High instruction count per thread.'); }
    } else if (isGeometry) {
      const relWork = utils.safeDiv(prims, primsP90, 0), relCost = utils.safeDiv(nsPerPrim, nsPerPrimMed, 1);
      if (relCost > CFG.HIGH_COST_MULT) {
        bound = 'Vertex Processing Cost'; icon = '📐'; confidence = utils.clamp01((relCost - 1) / CFG.HIGH_COST_MULT);
        reasoning.push(`Each primitive takes <b>${nsPerPrim.toFixed(1)} ns</b> (median: ${nsPerPrimMed.toFixed(1)} ns).`);
      } else if (relWork > CFG.HIGH_WORK_MULT) {
        bound = 'High Primitive Count'; icon = '🔢'; confidence = utils.clamp01((relWork - 1) / CFG.HIGH_WORK_MULT);
        reasoning.push(`Sheer volume of primitives (${utils.fmtInt(prims)}) is the main factor.`);
      } else { bound = 'Geometry (General)'; icon = '🔺'; confidence = 0.4; }
    } else if (isPixel) {
      const relWork = utils.safeDiv(samples, samplesP90, 0), relCost = utils.safeDiv(nsPerSample, nsPerSampleMed, 1);
      const lowCache = (l1Hit > 0 && l1Hit < CFG.LOW_L1_HIT_PCT) || (l2Hit > 0 && l2Hit < CFG.LOW_L2_HIT_PCT);
      const writeRatio = utils.safeDiv(dramWrite, dramBytes, 0);

      if (writeRatio > 0.60) {
           bound = 'ROP / Backend Bound'; icon = '💾'; confidence = 0.75;
           reasoning.push(`<b>${(writeRatio*100).toFixed(0)}%</b> of memory traffic is writing. Heavy blending or RT clearing.`);
      } else if (relCost > CFG.HIGH_COST_MULT) {
        const relBytes = utils.safeDiv(bytesPerSample, 1, 1), relInst = utils.safeDiv(instPerSample, instPerSampleMed, 1);
        if ((dramBW > dramBWP90 * 0.8 || relBytes > 1.0) && lowCache) {
          bound = 'Memory Bandwidth / Latency'; icon = '🐌'; confidence = utils.clamp01(0.6 + 0.4 * utils.clamp01((relCost - 1) / CFG.HIGH_COST_MULT));
          reasoning.push(`Low cache hit rates (L1: ${utils.fmtPct(l1Hit)}). Waiting for VRAM.`);
        } else if (dramBW < dramBWP90 * 0.4 && relInst < 0.6 && lowCache) {
            bound = 'Texture Latency'; icon = '⏳'; confidence = 0.65; reasoning.push('High duration but low throughput. Likely random texture fetches.');
        } else if (relInst > relBytes) {
          bound = 'ALU / Math Bound'; icon = '➗'; confidence = utils.clamp01(0.55 + 0.45 * utils.clamp01((relCost - 1) / CFG.HIGH_COST_MULT));
          reasoning.push(`High instruction intensity (${utils.fmtInt(instPerSample)} inst/sample).`);
        } else { bound = 'Heavy Pixel Shader'; icon = '🎨'; confidence = 0.5; reasoning.push('Mix of math and memory pressure.'); }
        if (utils.isNumber(regsPct) && regsPct >= CFG.HIGH_REGS_PCT) reasoning.push(`High Register Pressure (${utils.fmtPct(regsPct)}) limits occupancy.`);
      } else if (relWork > CFG.HIGH_WORK_MULT) {
        bound = 'Pixel Throughput'; icon = '📺'; confidence = utils.clamp01(0.40 + 0.50 * utils.clamp01((relWork - 1) / CFG.HIGH_WORK_MULT));
        reasoning.push('Large number of pixels processed. Shader cost is normal.');
      } else { bound = 'Pixel Processing'; icon = '🖌️'; confidence = 0.35; reasoning.push('Standard pixel work.'); }
    }

    // Build UI
    const root = document.createElement('div');
    root.style.fontFamily = 'var(--font-family)'; root.style.padding = '10px';

    const card = document.createElement('div');
    card.style.background = 'var(--panel-bg)'; card.style.borderLeft = '6px solid var(--accent-color)';
    card.style.borderRadius = '4px'; card.style.padding = '16px'; card.style.marginBottom = '20px';
    card.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';

    const cardHeader = document.createElement('div');
    cardHeader.style.display = 'flex'; cardHeader.style.alignItems = 'center'; cardHeader.style.gap = '12px';
    const iconEl = document.createElement('div'); iconEl.textContent = icon; iconEl.style.fontSize = '24px';
    const titleCol = document.createElement('div'); titleCol.style.flex = '1';
    const titleText = document.createElement('div'); titleText.textContent = bound; titleText.style.fontSize = '18px'; titleText.style.fontWeight = '700'; titleText.style.color = 'var(--text-color)';
    const confRow = document.createElement('div'); confRow.style.display = 'flex'; confRow.style.alignItems = 'center'; confRow.style.gap = '10px'; confRow.style.fontSize = '12px'; confRow.style.opacity = '0.8'; confRow.style.marginTop = '4px';
    const confLabel = document.createElement('span'); confLabel.textContent = `Confidence: ${(confidence * 100).toFixed(0)}%`;
    const confBarBg = document.createElement('div'); confBarBg.style.width = '100px'; confBarBg.style.height = '6px'; confBarBg.style.background = 'rgba(128,128,128,0.3)'; confBarBg.style.borderRadius = '3px'; confBarBg.style.overflow = 'hidden';
    const confBarFill = document.createElement('div'); confBarFill.style.width = `${confidence * 100}%`; confBarFill.style.height = '100%';
    confBarFill.style.background = confidence > 0.7 ? '#4caf50' : (confidence > 0.4 ? '#ff9800' : '#f44336');
    confBarBg.appendChild(confBarFill); confRow.appendChild(confLabel); confRow.appendChild(confBarBg);
    titleCol.appendChild(titleText); titleCol.appendChild(confRow); cardHeader.appendChild(iconEl); cardHeader.appendChild(titleCol);
    card.appendChild(cardHeader);

    if (reasoning.length > 0) {
        const reasonBox = document.createElement('div'); reasonBox.style.marginTop = '12px'; reasonBox.style.paddingTop = '12px'; reasonBox.style.borderTop = '1px solid var(--border-color)';
        const ul = document.createElement('ul'); ul.style.margin = '0'; ul.style.paddingLeft = '20px'; ul.style.lineHeight = '1.5';
        reasoning.forEach(r => { const li = document.createElement('li'); li.innerHTML = r; li.style.fontSize = '13px'; ul.appendChild(li); });
        reasonBox.appendChild(ul); card.appendChild(reasonBox);
    }
    root.appendChild(card);

    const addRow = (l, v, d) => {
      const name = utils.resolveMetric(headers, d);
      let val = 0, max = 1;
      if (name && state.counterMinMax && state.counterMinMax[name]) { val = agg[name] || 0; max = state.counterMinMax[name].max || 1; }
      root.appendChild(utils.createMetricRow(l, v, utils.createBar(val, max, '#777')));
    };

    const evidenceTitle = document.createElement('div'); evidenceTitle.style.fontWeight = '700'; evidenceTitle.style.margin = '15px 0 8px'; evidenceTitle.textContent = 'Evidence (Key Counters)';
    root.appendChild(evidenceTitle);
    addRow('GPU time', utils.fmtNs(timeNs), METRICS.GPU_TIME_NS);
    addRow('GPU active', utils.fmtNs(activeNs), METRICS.GPU_ACTIVE_NS);
    addRow('Samples passed', utils.fmtInt(samples), METRICS.SAMPLES_PASSED);
    addRow('PS invocations', utils.fmtInt(ps), METRICS.PS_INVOCATIONS);
    addRow('VS invocations', utils.fmtInt(vs), METRICS.VS_INVOCATIONS);
    addRow('CS invocations', utils.fmtInt(cs), METRICS.CS_INVOCATIONS);
    addRow('Rasterized prims', utils.fmtInt(prims), METRICS.RASTERIZED_PRIMS);
    addRow('DRAM read', utils.fmtBytes(dramRead), METRICS.DRAM_READ_BYTES);
    addRow('DRAM write', utils.fmtBytes(dramWrite), METRICS.DRAM_WRITE_BYTES);

    const derivedTitle = document.createElement('div'); derivedTitle.style.fontWeight = '700'; derivedTitle.style.margin = '20px 0 8px'; derivedTitle.textContent = 'Derived Metrics';
    root.appendChild(derivedTitle);
    const derived = document.createElement('div'); derived.style.display = 'flex'; derived.style.flexDirection = 'column'; derived.style.borderRadius = '6px'; derived.style.overflow = 'hidden';
    const addKV = (k, v) => derived.appendChild(utils.createMetricRow(k, v, ""));
    addKV('ns / sample', utils.isNumber(nsPerSample) ? `${nsPerSample.toFixed(1)} ns` : 'n/a');
    addKV('ns / primitive', utils.isNumber(nsPerPrim) ? `${nsPerPrim.toFixed(1)} ns` : 'n/a');
    addKV('DRAM Throughput', utils.fmtGBps(dramBytes, timeNs));
    addKV('L1 Cache Hit', utils.fmtPct(l1Hit));
    addKV('L2 Cache Hit', utils.fmtPct(l2Hit));
    addKV('Bytes / Sample', utils.isNumber(bytesPerSample) ? utils.fmtBytes(bytesPerSample) : 'n/a');
    addKV('Inst / Sample', utils.isNumber(instPerSample) ? utils.fmtInt(instPerSample) : 'n/a');
    addKV('Register Pressure (3D)', utils.isNumber(regsPct) ? utils.fmtPct(regsPct) : 'n/a');
    root.appendChild(derived);

    if (bound.includes('Pixel') || bound.includes('Compute') || bound.includes('ROP')) {
        const hint = document.createElement('div'); hint.style.marginTop = '15px'; hint.style.fontSize = '12px'; hint.style.opacity = '0.7';
        hint.innerHTML = '💡 Tip: Switch to <b>ShaderXray</b> tab for stall breakdown.';
        root.appendChild(hint);
    }
    container.appendChild(root);
  }

  PluginManager.register({ id: TAB_ID, name: TAB_NAME, description: 'Evidence-based guess of limiting factor.', order: TAB_ORDER, render });
})();