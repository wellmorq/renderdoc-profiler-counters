// BoundDetectorAdvanced (RenderDoc UI plugin)
// Auto-diagnose likely bottleneck for the selected draw/dispatch using a small, validated metric set.
//
// This version is adapted to real counters present in `all.json` for NVIDIA + RenderDoc.
// It avoids unsupported "Throughput" and Top_Level_Triage.* counters and uses robust name matching
// (works with headers that include units like " (...)").
//
// Author: generated with GPT-5.2 Pro

(function () {
  'use strict';

  const TAB_ID = 'bound-detector-advanced';
  const TAB_NAME = 'BoundDetectorAdvanced';
  const TAB_ORDER = 2;

  // ------------------------------
  // Metric name helpers
  // ------------------------------
  const c = (base, extra = []) => [
    `${base}.sum`,
    `${base}.avg`,
    `${base}.max`,
    `${base}.min`,
    base,
    ...extra
  ];

  const r = (base, extra = []) => [
    `${base}.avg.pct`,
    `${base}.avg.ratio`,
    `${base}.avg`,
    `${base}.pct`,
    `${base}.ratio`,
    base,
    ...extra
  ];

  const g = (name, extra = []) => [name, ...extra];

  // For registers we want both: absolute count and percent-of-max.
  const regCount = (base) => [
    `${base}.avg.ratio`,
    `${base}.avg`,
    base
  ];
  const regPct = (base) => [
    `${base}.avg.pct`,
    `${base}.pct`,
    `${base}.avg`,
    base
  ];

  // ------------------------------
  // Metrics used by this plugin
  // ------------------------------
  const METRICS = {
    // Time
    GPU_TIME: c('gpu__time_duration', g('GPU Duration', ['GPU Duration (ms)'])),
    GPU_ACTIVE: c('gpu__time_active'),

    // RenderDoc pipeline stats (Generic)
    SAMPLES_PASSED: g('Samples Passed'),
    PS_INVOCATIONS: g('PS Invocations'),
    VS_INVOCATIONS: g('VS Invocations'),
    CS_INVOCATIONS: g('CS Invocations'),
    RASTERIZED_PRIMS: g('Rasterized Primitives'),
    INPUT_VERTS: g('Input Vertices Read'),
    INPUT_PRIMS: g('Input Primitives'),
    GS_PRIMS: g('GS Primitives'),
    RASTERIZER_INVOCATIONS: g('Rasterizer Invocations'),

    // DRAM traffic
    DRAM_READ_BYTES: c('dram__bytes_op_read'),
    DRAM_WRITE_BYTES: c('dram__bytes_op_write'),
    DRAM_READ_SECTORS: c('dram__sectors_op_read'),
    DRAM_WRITE_SECTORS: c('dram__sectors_op_write'),

    // Cache hit-rates
    L1_HIT: r('l1tex__t_sector_hit_rate'),
    L2_HIT: r('lts__t_sector_hit_rate'),

    // Instructions (all + per stage)
    INST_ALL: c('sm__inst_executed'),
    INST_VS: c('smsp__inst_executed_shader_vs'),
    INST_TCS: c('smsp__inst_executed_shader_tcs'),
    INST_TES: c('smsp__inst_executed_shader_tes'),
    INST_GS: c('smsp__inst_executed_shader_gs'),
    INST_PS: c('smsp__inst_executed_shader_ps'),
    INST_CS: c('smsp__inst_executed_shader_cs'),

    // Warp stall breakdown (0..1 or 0..100)
    STALL_BARRIER: r('smsp__warp_issue_stalled_barrier_per_warp_active'),
    STALL_BRANCH: r('smsp__warp_issue_stalled_branch_resolving_per_warp_active'),
    STALL_DISPATCH: r('smsp__warp_issue_stalled_dispatch_stall_per_warp_active'),
    STALL_DRAIN: r('smsp__warp_issue_stalled_drain_per_warp_active'),
    STALL_LG: r('smsp__warp_issue_stalled_lg_throttle_per_warp_active'),
    STALL_LONG: r('smsp__warp_issue_stalled_long_scoreboard_per_warp_active'),
    STALL_LONG_L1TEX: r('smsp__warp_issue_stalled_long_scoreboard_pipe_l1tex_per_warp_active'),
    STALL_MATH: r('smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active'),
    STALL_MEMBAR: r('smsp__warp_issue_stalled_membar_per_warp_active'),
    STALL_MIO: r('smsp__warp_issue_stalled_mio_throttle_per_warp_active'),
    STALL_MIO_MIO: r('smsp__warp_issue_stalled_mio_throttle_pipe_mio_per_warp_active'),
    STALL_MISC: r('smsp__warp_issue_stalled_misc_per_warp_active'),
    STALL_NO_INSTR: r('smsp__warp_issue_stalled_no_instruction_per_warp_active'),
    STALL_NOT_SELECTED: r('smsp__warp_issue_stalled_not_selected_per_warp_active'),
    STALL_SELECTED: r('smsp__warp_issue_stalled_selected_per_warp_active'),
    STALL_SHORT: r('smsp__warp_issue_stalled_short_scoreboard_per_warp_active'),
    STALL_SLEEP: r('smsp__warp_issue_stalled_sleeping_per_warp_active'),
    STALL_TEX: r('smsp__warp_issue_stalled_tex_throttle_per_warp_active'),
    STALL_WAIT: r('smsp__warp_issue_stalled_wait_per_warp_active'),

    // Registers per thread
    REGS_3D_COUNT: regCount('tpc__average_registers_per_thread_shader_3d'),
    REGS_3D_PCT: regPct('tpc__average_registers_per_thread_shader_3d'),
    REGS_PS_COUNT: regCount('tpc__average_registers_per_thread_shader_ps'),
    REGS_PS_PCT: regPct('tpc__average_registers_per_thread_shader_ps'),
    REGS_VTG_COUNT: regCount('tpc__average_registers_per_thread_shader_vtg'),
    REGS_VTG_PCT: regPct('tpc__average_registers_per_thread_shader_vtg'),
    REGS_CS_COUNT: regCount('tpc__average_registers_per_thread_shader_cs'),
    REGS_CS_PCT: regPct('tpc__average_registers_per_thread_shader_cs'),

    // Shared memory (to catch bank conflicts / heavy LDS usage)
    SH_WF_ALL: c('l1tex__data_pipe_lsu_wavefronts_mem_shared'),
    SH_WF_LD: c('l1tex__data_pipe_lsu_wavefronts_mem_shared_op_ld'),
    SH_WF_ST: c('l1tex__data_pipe_lsu_wavefronts_mem_shared_op_st'),
    SH_WF_ATOM: c('l1tex__data_pipe_lsu_wavefronts_mem_shared_op_atom'),
    SH_BANK_CONFLICTS: c('l1tex__data_bank_conflicts_pipe_lsu_mem_shared'),
    SH_BYTES_READ: c('smsp__bytes_mem_shared_cmd_read'),
    SH_BYTES_ATOM: c('smsp__bytes_mem_shared_cmd_atom'),

    // Backend proxies (color/depth output traffic)
    CROP_READ_SUBPK: c('crop__read_subpackets'),
    CROP_WRITE_SUBPK: c('crop__write_subpackets'),
    ZROP_READ_SUBPK: c('zrop__read_subpackets'),
    ZROP_WRITE_SUBPK: c('zrop__write_subpackets'),
  };

  // ------------------------------
  // Config / thresholds (heuristics)
  // ------------------------------
  const CFG = {
    ACTIVE_RATIO_LOW: 0.65,

    CACHE_LOW: 0.60,
    CACHE_OK: 0.75,

    // Warp stall thresholds (these are proportions of warps per cycle)
    STALL_SUSPECT: 0.15,
    STALL_HIGH: 0.25,
    STALL_VERY_HIGH: 0.40,

    // Bank conflicts: conflicts per shared wavefront (rough heuristic)
    BANKCONFLICT_HIGH: 0.30,

    // Write-heavy traffic ratio
    WRITE_HEAVY: 0.60,
  };

  // ------------------------------
  // Small math helpers
  // ------------------------------
  function quantile(arr, q) {
    if (!arr || arr.length === 0) return NaN;
    const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
    if (a.length === 0) return NaN;
    const pos = (a.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
    return a[base];
  }
  const median = (arr) => quantile(arr, 0.5);

  function clamp01(x) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
  }

  // Normalize values that can appear as 0..1 or 0..100 (percent).
  function to01(v, opts) {
    if (!Number.isFinite(v)) return NaN;
    const o = opts || {};
    const zeroIsNaN = !!o.zeroIsNaN;
    const max = Number.isFinite(o.max) ? o.max : 9.99;

    let p = v;
    if (p > 1.5) p = p / 100.0; // assume percent
    if (zeroIsNaN && p === 0) return NaN;
    if (p < 0) return NaN;
    if (p > max) return NaN;
    return p;
  }

  function fmtPct01(p01) {
    if (!Number.isFinite(p01)) return 'n/a';
    return `${(clamp01(p01) * 100).toFixed(0)}%`;
  }

  function fmtMaybeNs(utils, ns) {
    if (!utils.isNumber(ns) || ns <= 0) return 'n/a';
    return utils.fmtNs(ns);
  }

  function fmtMaybeInt(utils, x) {
    if (!utils.isNumber(x)) return 'n/a';
    return utils.fmtInt(x);
  }

  function fmtMaybeGBps(utils, bytes, ns) {
    if (!utils.isNumber(bytes) || !utils.isNumber(ns) || ns <= 0) return 'n/a';
    return utils.fmtGBps(bytes, ns);
  }

  function safeDiv(utils, a, b) {
    if (!utils.isNumber(a) || !utils.isNumber(b) || b === 0) return NaN;
    return utils.safeDiv(a, b);
  }

  // ------------------------------
  // Robust metric resolver (handles headers with unit suffix)
  // ------------------------------
  function normalizeHeader(h) {
    let s = String(h || '').trim();
    if (!s) return '';
    // Strip trailing unit suffix: " ... (bytes)" / " ... (%)" / " ... (ms)" etc.
    const m = s.match(/^(.*)\s+\([^)]*\)\s*$/);
    if (m) s = m[1];
    return s.trim().toLowerCase();
  }

  function makeResolver(headers) {
    const map = new Map();
    (headers || []).forEach((h) => {
      const s = String(h || '').trim();
      if (!s) return;
      map.set(s, h);
      map.set(s.toLowerCase(), h);
      map.set(normalizeHeader(s), h);
    });

    return function resolve(def) {
      const arr = Array.isArray(def) ? def : [def];
      for (const cand of arr) {
        if (!cand) continue;
        const c = String(cand).trim();
        if (!c) continue;
        const direct = map.get(c) || map.get(c.toLowerCase()) || map.get(normalizeHeader(c));
        if (direct) return direct;
      }
      return null;
    };
  }

  // ------------------------------
  // Access helpers
  // ------------------------------
  function getAggSafe(agg, resolve, def, utils, missing, label) {
    const name = resolve(def);
    if (!name) {
      if (missing) missing.push(label || (Array.isArray(def) ? def[0] : def));
      return { v: NaN, name: null };
    }
    const v = agg ? agg[name] : NaN;
    if (!utils.isNumber(v)) return { v: NaN, name };
    return { v, name };
  }

  function collect(state, resolve, def, utils, predicateFn) {
    const name = resolve(def);
    if (!name) return [];
    const out = [];
    (state.counters || []).forEach((m) => {
      const v = m[name];
      if (!utils.isNumber(v)) return;
      if (predicateFn && !predicateFn(v, m)) return;
      out.push(v);
    });
    return out;
  }

  // ------------------------------
  // UI helpers
  // ------------------------------
  function makeMissingBox(container, missing) {
    if (!missing || missing.length === 0) return;
    const box = document.createElement('div');
    box.style.marginTop = '12px';
    box.style.padding = '10px';
    box.style.border = '1px dashed var(--border-color)';
    box.style.borderRadius = '6px';
    box.style.opacity = '0.9';

    const t = document.createElement('div');
    t.textContent = `⚠️ Не хватает метрик (точность ниже): ${missing.length}`;
    t.style.fontWeight = '700';
    t.style.marginBottom = '6px';

    const pre = document.createElement('pre');
    pre.style.margin = '0';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.fontSize = '11px';
    pre.style.lineHeight = '1.35';
    pre.textContent = missing.slice(0, 80).join('\n') + (missing.length > 80 ? '\n…' : '');

    box.appendChild(t);
    box.appendChild(pre);
    container.appendChild(box);
  }

  // ------------------------------
  // Main render
  // ------------------------------
  function render(container, ctx) {
    container.innerHTML = '';
    const { node, agg, state, utils } = ctx;

    if (!node) {
      container.innerHTML = '<div style="padding:10px">Выбери событие на таймлайне.</div>';
      return;
    }

    const headers = state.headers || [];
    const resolve = makeResolver(headers);

    // Missing metrics (in this capture at all)
    const missing = [];
    const metricKeys = Object.keys(METRICS);
    metricKeys.forEach((k) => {
      const def = METRICS[k];
      if (typeof def === 'string' || Array.isArray(def)) {
        if (!resolve(def)) missing.push(Array.isArray(def) ? def[0] : def);
      }
    });

    const coverage = metricKeys.length > 0 ? clamp01(1 - missing.length / metricKeys.length) : 1;

    // ---- Read current metrics ----
    let timeNs = getAggSafe(agg, resolve, METRICS.GPU_TIME, utils, missing, 'gpu time').v;
    const timeName = getAggSafe(agg, resolve, METRICS.GPU_TIME, utils).name;

    // If we used GPU Duration (ms) or any header ending with "(ms)", convert to ns.
    if (utils.isNumber(timeNs) && timeName) {
      const isMs =
        /ms\)?$/i.test(timeName) ||
        (/^GPU Duration/i.test(timeName) && !/gpu__time_/i.test(timeName));
      if (isMs) timeNs *= 1e6;
    }

    let activeNs = getAggSafe(agg, resolve, METRICS.GPU_ACTIVE, utils, missing, 'gpu active').v;

    const dramRead = getAggSafe(agg, resolve, METRICS.DRAM_READ_BYTES, utils).v;
    const dramWrite = getAggSafe(agg, resolve, METRICS.DRAM_WRITE_BYTES, utils).v;

    const dramReadS = getAggSafe(agg, resolve, METRICS.DRAM_READ_SECTORS, utils).v;
    const dramWriteS = getAggSafe(agg, resolve, METRICS.DRAM_WRITE_SECTORS, utils).v;

    const instAll = getAggSafe(agg, resolve, METRICS.INST_ALL, utils).v;
    const instVS = getAggSafe(agg, resolve, METRICS.INST_VS, utils).v;
    const instTCS = getAggSafe(agg, resolve, METRICS.INST_TCS, utils).v;
    const instTES = getAggSafe(agg, resolve, METRICS.INST_TES, utils).v;
    const instGS = getAggSafe(agg, resolve, METRICS.INST_GS, utils).v;
    const instPS = getAggSafe(agg, resolve, METRICS.INST_PS, utils).v;
    const instCS = getAggSafe(agg, resolve, METRICS.INST_CS, utils).v;

    const l1Hit = to01(getAggSafe(agg, resolve, METRICS.L1_HIT, utils).v, { zeroIsNaN: true, max: 1.2 });
    const l2Hit = to01(getAggSafe(agg, resolve, METRICS.L2_HIT, utils).v, { zeroIsNaN: true, max: 1.2 });

    // Generic pipeline stats (may be missing if not enabled)
    const samples = getAggSafe(agg, resolve, METRICS.SAMPLES_PASSED, utils).v;
    const psInv = getAggSafe(agg, resolve, METRICS.PS_INVOCATIONS, utils).v;
    const vsInv = getAggSafe(agg, resolve, METRICS.VS_INVOCATIONS, utils).v;
    const csInv = getAggSafe(agg, resolve, METRICS.CS_INVOCATIONS, utils).v;
    const prims = getAggSafe(agg, resolve, METRICS.RASTERIZED_PRIMS, utils).v;

    // Stalls (0..1)
    const stalls = {
      barrier: to01(getAggSafe(agg, resolve, METRICS.STALL_BARRIER, utils).v),
      branch: to01(getAggSafe(agg, resolve, METRICS.STALL_BRANCH, utils).v),
      dispatch: to01(getAggSafe(agg, resolve, METRICS.STALL_DISPATCH, utils).v),
      drain: to01(getAggSafe(agg, resolve, METRICS.STALL_DRAIN, utils).v),
      lg: to01(getAggSafe(agg, resolve, METRICS.STALL_LG, utils).v),
      long: to01(getAggSafe(agg, resolve, METRICS.STALL_LONG, utils).v),
      longL1tex: to01(getAggSafe(agg, resolve, METRICS.STALL_LONG_L1TEX, utils).v),
      math: to01(getAggSafe(agg, resolve, METRICS.STALL_MATH, utils).v),
      membar: to01(getAggSafe(agg, resolve, METRICS.STALL_MEMBAR, utils).v),
      mio: to01(getAggSafe(agg, resolve, METRICS.STALL_MIO, utils).v),
      mioMio: to01(getAggSafe(agg, resolve, METRICS.STALL_MIO_MIO, utils).v),
      misc: to01(getAggSafe(agg, resolve, METRICS.STALL_MISC, utils).v),
      noInstr: to01(getAggSafe(agg, resolve, METRICS.STALL_NO_INSTR, utils).v),
      notSelected: to01(getAggSafe(agg, resolve, METRICS.STALL_NOT_SELECTED, utils).v),
      selected: to01(getAggSafe(agg, resolve, METRICS.STALL_SELECTED, utils).v),
      short: to01(getAggSafe(agg, resolve, METRICS.STALL_SHORT, utils).v),
      sleep: to01(getAggSafe(agg, resolve, METRICS.STALL_SLEEP, utils).v),
      tex: to01(getAggSafe(agg, resolve, METRICS.STALL_TEX, utils).v),
      wait: to01(getAggSafe(agg, resolve, METRICS.STALL_WAIT, utils).v),
    };

    // Registers (count + percent)
    const regs = {
      psCount: getAggSafe(agg, resolve, METRICS.REGS_PS_COUNT, utils).v,
      psPct: to01(getAggSafe(agg, resolve, METRICS.REGS_PS_PCT, utils).v, { zeroIsNaN: true, max: 2 }),
      vtgCount: getAggSafe(agg, resolve, METRICS.REGS_VTG_COUNT, utils).v,
      vtgPct: to01(getAggSafe(agg, resolve, METRICS.REGS_VTG_PCT, utils).v, { zeroIsNaN: true, max: 2 }),
      csCount: getAggSafe(agg, resolve, METRICS.REGS_CS_COUNT, utils).v,
      csPct: to01(getAggSafe(agg, resolve, METRICS.REGS_CS_PCT, utils).v, { zeroIsNaN: true, max: 2 }),
      d3Count: getAggSafe(agg, resolve, METRICS.REGS_3D_COUNT, utils).v,
      d3Pct: to01(getAggSafe(agg, resolve, METRICS.REGS_3D_PCT, utils).v, { zeroIsNaN: true, max: 2 }),
    };

    // Shared memory
    const sh = {
      wfAll: getAggSafe(agg, resolve, METRICS.SH_WF_ALL, utils).v,
      wfLd: getAggSafe(agg, resolve, METRICS.SH_WF_LD, utils).v,
      wfSt: getAggSafe(agg, resolve, METRICS.SH_WF_ST, utils).v,
      wfAtom: getAggSafe(agg, resolve, METRICS.SH_WF_ATOM, utils).v,
      bankConf: getAggSafe(agg, resolve, METRICS.SH_BANK_CONFLICTS, utils).v,
      bytesRead: getAggSafe(agg, resolve, METRICS.SH_BYTES_READ, utils).v,
      bytesAtom: getAggSafe(agg, resolve, METRICS.SH_BYTES_ATOM, utils).v,
    };

    // Backend proxies (subpackets)
    const backend = {
      cropR: getAggSafe(agg, resolve, METRICS.CROP_READ_SUBPK, utils).v,
      cropW: getAggSafe(agg, resolve, METRICS.CROP_WRITE_SUBPK, utils).v,
      zropR: getAggSafe(agg, resolve, METRICS.ZROP_READ_SUBPK, utils).v,
      zropW: getAggSafe(agg, resolve, METRICS.ZROP_WRITE_SUBPK, utils).v,
    };

    // ---- Derived values ----
    const activeRatio = (utils.isNumber(activeNs) && utils.isNumber(timeNs) && timeNs > 0)
      ? clamp01(activeNs / timeNs) : NaN;

    const dramBytes = (utils.isNumber(dramRead) ? dramRead : 0) + (utils.isNumber(dramWrite) ? dramWrite : 0);
    const dramBW = (utils.isNumber(dramBytes) && utils.isNumber(timeNs) && timeNs > 0)
      ? (dramBytes * 1e9 / timeNs) : NaN; // bytes/sec

    const writeRatio = (utils.isNumber(dramRead) && utils.isNumber(dramWrite) && (dramRead + dramWrite) > 0)
      ? clamp01(dramWrite / (dramRead + dramWrite)) : NaN;

    const bytesPerInst = (utils.isNumber(dramBytes) && utils.isNumber(instAll) && instAll > 0)
      ? (dramBytes / instAll) : NaN;

    const vtgInst = (utils.isNumber(instVS) ? instVS : 0) +
      (utils.isNumber(instTCS) ? instTCS : 0) +
      (utils.isNumber(instTES) ? instTES : 0) +
      (utils.isNumber(instGS) ? instGS : 0);

    const psInst = utils.isNumber(instPS) ? instPS : 0;
    const csInst = utils.isNumber(instCS) ? instCS : 0;
    const sumStageInst = vtgInst + psInst + csInst;

    // Dominant stage (best-effort)
    const stage = { kind: 'Mixed', label: 'Смешанная нагрузка', share: NaN };
    if (sumStageInst > 0) {
      const pV = vtgInst / sumStageInst, pP = psInst / sumStageInst, pC = csInst / sumStageInst;
      const maxP = Math.max(pV, pP, pC);
      stage.share = maxP;
      if (pC === maxP) { stage.kind = 'CS'; stage.label = 'Compute шейдер'; }
      else if (pP === maxP) { stage.kind = 'PS'; stage.label = 'Пиксельный шейдер'; }
      else { stage.kind = 'VTG'; stage.label = 'Вершины/тесселяция/геометрия'; }
      if (maxP < 0.55) { stage.kind = 'Mixed'; stage.label = 'Смешанная нагрузка'; }
    } else {
      // fallback by invocations
      const invs = {
        CS: utils.isNumber(csInv) ? csInv : 0,
        PS: utils.isNumber(psInv) ? psInv : 0,
        VTG: utils.isNumber(vsInv) ? vsInv : 0
      };
      const maxInv = Math.max(invs.CS, invs.PS, invs.VTG);
      if (maxInv > 0) {
        if (invs.CS === maxInv) { stage.kind = 'CS'; stage.label = 'Compute шейдер'; }
        else if (invs.PS === maxInv) { stage.kind = 'PS'; stage.label = 'Пиксельный шейдер'; }
        else { stage.kind = 'VTG'; stage.label = 'Вершины/тесселяция/геометрия'; }
      }
    }

    // Pick register metrics for the dominant stage (for advice)
    let regCountNow = NaN, regPctNow = NaN;
    if (stage.kind === 'PS') { regCountNow = regs.psCount; regPctNow = regs.psPct; }
    else if (stage.kind === 'CS') { regCountNow = regs.csCount; regPctNow = regs.csPct; }
    else if (stage.kind === 'VTG') { regCountNow = regs.vtgCount; regPctNow = regs.vtgPct; }
    else { regCountNow = regs.d3Count; regPctNow = regs.d3Pct; }

    const bankConfPerWf = (utils.isNumber(sh.bankConf) && utils.isNumber(sh.wfAll) && sh.wfAll > 0)
      ? (sh.bankConf / sh.wfAll) : NaN;

    const shBytes = (utils.isNumber(sh.bytesRead) ? sh.bytesRead : 0) + (utils.isNumber(sh.bytesAtom) ? sh.bytesAtom : 0);
    const shBW = (utils.isNumber(shBytes) && utils.isNumber(timeNs) && timeNs > 0)
      ? (shBytes * 1e9 / timeNs) : NaN;

    const backendWrites = (utils.isNumber(backend.cropW) ? backend.cropW : 0) + (utils.isNumber(backend.zropW) ? backend.zropW : 0);
    const backendWriteRate = (utils.isNumber(backendWrites) && utils.isNumber(timeNs) && timeNs > 0)
      ? (backendWrites * 1e9 / timeNs) : NaN;

    // ---- Baselines (p90) across capture ----
    const timeHeader = resolve(METRICS.GPU_TIME);
    const readHeader = resolve(METRICS.DRAM_READ_BYTES);
    const writeHeader = resolve(METRICS.DRAM_WRITE_BYTES);
    const instHeader = resolve(METRICS.INST_ALL);

    // Convert time per-row to ns if needed.
    const isTimeMs = (timeHeader && (/ms\)?$/i.test(timeHeader) || (/^GPU Duration/i.test(timeHeader) && !/gpu__time_/i.test(timeHeader))));

    const dramBWArr = [];
    const bytesPerInstArr = [];
    const backendWriteRateArr = [];
    const bankConfArr = [];

    const cropWHeader = resolve(METRICS.CROP_WRITE_SUBPK);
    const zropWHeader = resolve(METRICS.ZROP_WRITE_SUBPK);
    const shWfHeader = resolve(METRICS.SH_WF_ALL);
    const shBcHeader = resolve(METRICS.SH_BANK_CONFLICTS);

    (state.counters || []).forEach((m) => {
      const tRaw = timeHeader ? m[timeHeader] : NaN;
      const tNs = (utils.isNumber(tRaw) && tRaw > 0) ? (isTimeMs ? tRaw * 1e6 : tRaw) : NaN;
      if (!Number.isFinite(tNs) || tNs <= 0) return;

      if (readHeader && writeHeader) {
        const rr = m[readHeader], ww = m[writeHeader];
        if (utils.isNumber(rr) && utils.isNumber(ww)) {
          const bw = (rr + ww) * 1e9 / tNs;
          if (Number.isFinite(bw)) dramBWArr.push(bw);
        }
      }

      if (readHeader && writeHeader && instHeader) {
        const rr = m[readHeader], ww = m[writeHeader], ii = m[instHeader];
        if (utils.isNumber(rr) && utils.isNumber(ww) && utils.isNumber(ii) && ii > 0) {
          const bpi = (rr + ww) / ii;
          if (Number.isFinite(bpi)) bytesPerInstArr.push(bpi);
        }
      }

      if (cropWHeader && zropWHeader) {
        const cw = m[cropWHeader], zw = m[zropWHeader];
        if (utils.isNumber(cw) && utils.isNumber(zw)) {
          const rate = (cw + zw) * 1e9 / tNs;
          if (Number.isFinite(rate)) backendWriteRateArr.push(rate);
        }
      }

      if (shWfHeader && shBcHeader) {
        const wf = m[shWfHeader], bc = m[shBcHeader];
        if (utils.isNumber(wf) && utils.isNumber(bc) && wf > 0) {
          const r = bc / wf;
          if (Number.isFinite(r)) bankConfArr.push(r);
        }
      }
    });

    const dramBWP90 = quantile(dramBWArr, 0.90);
    const bytesPerInstP90 = quantile(bytesPerInstArr, 0.90);
    const backendWriteRateP90 = quantile(backendWriteRateArr, 0.90);
    const bankConfP90 = quantile(bankConfArr, 0.90);

    // Cache evaluation
    const cacheKnown = Number.isFinite(l1Hit) || Number.isFinite(l2Hit);
    const cacheBad = cacheKnown && (
      (Number.isFinite(l1Hit) && l1Hit < CFG.CACHE_LOW) ||
      (Number.isFinite(l2Hit) && l2Hit < CFG.CACHE_LOW)
    );

    // ---- Helper: top stalls ----
    const stallList = [
      { k: 'long', label: 'Long scoreboard (ожидание данных)', v: stalls.long },
      { k: 'longL1tex', label: 'Long scoreboard L1TEX', v: stalls.longL1tex },
      { k: 'tex', label: 'Texture throttle', v: stalls.tex },
      { k: 'math', label: 'Math pipe throttle', v: stalls.math },
      { k: 'lg', label: 'LG throttle (LSU очередь)', v: stalls.lg },
      { k: 'notSelected', label: 'Not selected (низкая заселённость)', v: stalls.notSelected },
      { k: 'branch', label: 'Branch resolving', v: stalls.branch },
      { k: 'barrier', label: 'Barrier', v: stalls.barrier },
      { k: 'membar', label: 'Membar', v: stalls.membar },
      { k: 'noInstr', label: 'No instruction', v: stalls.noInstr },
      { k: 'dispatch', label: 'Dispatch stall', v: stalls.dispatch },
      { k: 'wait', label: 'Wait', v: stalls.wait },
      { k: 'short', label: 'Short scoreboard', v: stalls.short },
      { k: 'mio', label: 'MIO throttle', v: stalls.mio },
      { k: 'misc', label: 'Misc', v: stalls.misc },
      { k: 'drain', label: 'Drain', v: stalls.drain },
      { k: 'sleep', label: 'Sleeping', v: stalls.sleep },
    ].filter(x => Number.isFinite(x.v));

    stallList.sort((a, b) => b.v - a.v);
    const topStalls = stallList.slice(0, 3);

    // ------------------------------
    // Candidate scoring
    // ------------------------------
    const candidates = [];
    const add = (id, title, icon, score, why, check, fix) => {
      candidates.push({ id, title, icon, score: clamp01(score), why, check, fix });
    };

    // 1) GPU idle / sync / CPU-side limitation
    if (Number.isFinite(activeRatio) && utils.isNumber(timeNs) && timeNs > 0) {
      const s = activeRatio < CFG.ACTIVE_RATIO_LOW
        ? clamp01((CFG.ACTIVE_RATIO_LOW - activeRatio) / 0.35)
        : 0;
      if (s > 0.12) {
        add(
          'idle',
          'GPU простаивает (похоже на CPU/sync ограничение)',
          '⏳',
          s,
          [
            `Доля активной работы GPU низкая: <b>${fmtPct01(activeRatio)}</b>.`,
            'Это часто означает ожидание: синхронизация CPU↔GPU, лимит по CPU, либо ожидание Present/VSync.',
          ],
          'Быстрый тест: уменьши разрешение/качество. Если <b>GPU Duration почти не меняется</b> — узкое место не в этом draw по GPU, а выше (CPU/синхронизация).',
          [
            'Снизить количество draw/dispatch: батчинг, инстансинг, объединение материалов.',
            'Убрать синхронизации (readback, Map/Unmap с ожиданием, слишком ранний `WaitForIdle`).',
            'Проверить VSync / ограничители FPS / ожидание swapchain.',
          ]
        );
      }
    }

    // Helper numbers for memory
    const memBWRel = (Number.isFinite(dramBW) && Number.isFinite(dramBWP90) && dramBWP90 > 0)
      ? dramBW / dramBWP90 : NaN;

    const bpiRel = (Number.isFinite(bytesPerInst) && Number.isFinite(bytesPerInstP90) && bytesPerInstP90 > 0)
      ? bytesPerInst / bytesPerInstP90 : NaN;

    // 2) Texture pipe bound
    {
      const tex = stalls.tex;
      const longL1 = stalls.longL1tex;
      let s = 0;
      if (Number.isFinite(tex)) {
        s = clamp01((tex - 0.12) / 0.35);
        if (Number.isFinite(longL1)) s += 0.25 * clamp01((longL1 - 0.10) / 0.30);
        if (cacheBad) s += 0.10;
      }
      if (stage.kind === 'VTG') s *= 0.75; // texture in vertex exists, but чаще PS/CS
      if (s > 0.18) {
        add(
          'tex',
          'Ограничение в texture/L1TEX (много выборок, ждём текстуры)',
          '🧵',
          s,
          [
            `Texture throttle: <b>${fmtPct01(tex)}</b>${Number.isFinite(longL1) ? `, long-scoreboard(L1TEX): <b>${fmtPct01(longL1)}</b>` : ''}.`,
            cacheKnown ? `Hit-rate: L1 ~ <b>${fmtPct01(l1Hit)}</b>, L2 ~ <b>${fmtPct01(l2Hit)}</b>.` : 'Hit-rate кэшей недоступен.',
            Number.isFinite(memBWRel) ? `DRAM BW относительно сцены: ~ <b>${(memBWRel * 100).toFixed(0)}%</b> от p90.` : 'DRAM BW baseline недоступен.',
          ],
          'Проверка: временно уменьши число выборок текстур (замени текстуры на 1×1/LOD bias, отключи анизотропию) — <b>GPU Duration должна заметно упасть</b>.',
          [
            'Сократить число текстурных выборок (особенно в циклах).',
            'Понизить LOD/разрешение текстур для этого прохода, использовать более компактные форматы.',
            'Улучшить локальность: атласы, меньше разнородных текстур, избегать случайного доступа.',
          ]
        );
      }
    }

    // 3) Memory latency (long scoreboard)
    {
      const long = stalls.long;
      const longL1 = stalls.longL1tex;
      let s = 0;
      if (Number.isFinite(long)) {
        s = clamp01((long - 0.18) / 0.38);
        if (cacheBad) s += 0.15;
        if (Number.isFinite(memBWRel)) s += 0.20 * clamp01((memBWRel - 0.85) / 0.35);
        if (Number.isFinite(bpiRel)) s += 0.20 * clamp01((bpiRel - 0.85) / 0.35);
        if (Number.isFinite(longL1)) s += 0.10 * clamp01((longL1 - 0.10) / 0.30);
      }
      if (s > 0.18) {
        add(
          'mem-lat',
          'Ограничение по памяти (ожидание данных / cache-miss)',
          '📦',
          s,
          [
            `Long scoreboard: <b>${fmtPct01(long)}</b>${Number.isFinite(longL1) ? ` (L1TEX часть: <b>${fmtPct01(longL1)}</b>)` : ''}.`,
            cacheKnown ? `Hit-rate: L1 ~ <b>${fmtPct01(l1Hit)}</b>, L2 ~ <b>${fmtPct01(l2Hit)}</b>.` : 'Hit-rate кэшей недоступен.',
            `DRAM: read <b>${fmtMaybeInt(utils, dramRead)}</b>, write <b>${fmtMaybeInt(utils, dramWrite)}</b>, BW ~ <b>${fmtMaybeGBps(utils, dramBytes, timeNs)}</b>.`,
          ],
          'Проверка: временно сократи чтения/записи (например, отключи один буфер/текстуру или подставь константу вместо выборки). Если <b>GPU Duration падает</b> — это память.',
          [
            'Уплотнить данные (меньше байт на элемент), использовать более компактные форматы.',
            'Повысить локальность: последовательный доступ, уменьшить «прыгающие» индексы.',
            'Сократить количество обращений к памяти: кешировать в регистрах/ shared, объединять чтения.',
          ]
        );
      }
    }

    // 4) LSU/Load-Store queue pressure (LG throttle)
    {
      const lg = stalls.lg;
      let s = 0;
      if (Number.isFinite(lg)) {
        s = clamp01((lg - 0.10) / 0.30);
        if (Number.isFinite(bpiRel)) s += 0.15 * clamp01((bpiRel - 0.85) / 0.35);
      }
      if (s > 0.18) {
        add(
          'lsu',
          'Слишком много LD/ST (LSU очередь забита)',
          '🚚',
          s,
          [
            `LG throttle: <b>${fmtPct01(lg)}</b>.`,
            Number.isFinite(bytesPerInst) ? `Bytes/inst ~ <b>${bytesPerInst.toFixed(2)}</b> (отн. к p90: ${Number.isFinite(bpiRel) ? (bpiRel*100).toFixed(0)+'%' : 'n/a'}).` : 'Bytes/inst недоступен.',
          ],
          'Проверка: убери часть чтений/записей (например, один массив/RT), либо сделай «пустой» шейдер — `lg_throttle` и GPU Duration должны снизиться.',
          [
            'Свести несколько обращений в одно (векторные загрузки, упаковка данных).',
            'Избегать лишних записей, писать только то что нужно (mask/branch).',
            'Стараться читать/писать последовательно (coalescing), уменьшать разброс адресов.',
          ]
        );
      }
    }

    // 5) Compute/ALU bound (math pipe)
    {
      const math = stalls.math;
      const long = stalls.long;
      let s = 0;
      if (Number.isFinite(math)) {
        s = clamp01((math - 0.10) / 0.30);
        if (Number.isFinite(long) && long < 0.12) s += 0.10;
        if (cacheKnown && !cacheBad) s += 0.05;
      }
      if (s > 0.18) {
        add(
          'alu',
          'Ограничение по вычислениям (ALU/Math pipe)',
          '🧮',
          s,
          [
            `Math pipe throttle: <b>${fmtPct01(math)}</b>.`,
            Number.isFinite(instAll) ? `Инструкций выполнено: <b>${fmtMaybeInt(utils, instAll)}</b>.` : 'Инструкции: n/a.',
            `Время GPU: <b>${fmtMaybeNs(utils, timeNs)}</b>.`,
          ],
          'Проверка: упрости шейдер (убери циклы/дорогие функции типа pow/exp/sin, снизь качество) — время должно заметно уменьшиться.',
          [
            'Убрать/сократить циклы, уменьшить количество операций на пиксель/вершину.',
            'Заменять дорогие функции приближениями, использовать LUT где уместно.',
            'Снижать точность там где можно (half/mediump), избегать лишних нормализаций.',
          ]
        );
      }
    }

    // 6) Occupancy / register pressure (not selected)
    {
      const ns = stalls.notSelected;
      let s = 0;
      if (Number.isFinite(ns)) {
        s = clamp01((ns - 0.18) / 0.35);
        if (Number.isFinite(regPctNow)) s += 0.25 * clamp01((regPctNow - 0.60) / 0.35);
        if (Number.isFinite(regCountNow)) s += 0.15 * clamp01((regCountNow - 80) / 80);
      }
      if (s > 0.18) {
        add(
          'occ',
          'Низкая заселённость (регистры/ресурсы ограничивают occupancy)',
          '🧩',
          s,
          [
            `Not selected: <b>${fmtPct01(ns)}</b> — много варпов не может быть запущено параллельно.`,
            Number.isFinite(regCountNow) ? `Регистры на поток: ~ <b>${regCountNow.toFixed(0)}</b>${Number.isFinite(regPctNow) ? ` (${fmtPct01(regPctNow)} от максимума)` : ''}.` : (Number.isFinite(regPctNow) ? `Регистры (pct): <b>${fmtPct01(regPctNow)}</b>.` : 'Регистры: n/a.'),
            `Доминирующая стадия: <b>${stage.label}</b>.`,
          ],
          'Проверка: попробуй снизить давление по регистрам (убрать unroll, разбить шейдер, ограничить регистры при компиляции) — `not_selected` должен уменьшиться, а GPU Duration — снизиться.',
          [
            'Сократить количество временных переменных и больших локальных массивов.',
            'Избегать агрессивной развёртки циклов (unroll) — она раздувает регистры.',
            'Для compute: подобрать размер группы (block size), чтобы улучшить occupancy.',
          ]
        );
      }
    }

    // 7) Branch divergence
    {
      const br = stalls.branch;
      let s = 0;
      if (Number.isFinite(br)) {
        s = clamp01((br - 0.06) / 0.20);
      }
      if (s > 0.18) {
        add(
          'branch',
          'Ветвления/дивергенция (warps расходятся по путям)',
          '🌿',
          s,
          [
            `Branch resolving: <b>${fmtPct01(br)}</b>.`,
            `Стадия: <b>${stage.label}</b>.`,
          ],
          'Проверка: сделай ветку константной (временно «заставь» один путь) — если время падает, проблема в divergence.',
          [
            'Стараться, чтобы потоки в одном варпе шли по одному пути (упорядочить данные, сгруппировать случаи).',
            'Заменять ветвления на предикацию там, где это проще и выгоднее.',
            'Избегать вложенных веток и ранних выходов в горячем коде.',
          ]
        );
      }
    }

    // 8) Synchronization / barriers
    {
      const b = stalls.barrier;
      let s = 0;
      if (Number.isFinite(b)) {
        s = clamp01((b - 0.08) / 0.25);
        if (stage.kind !== 'CS') s *= 0.85; // barrier чаще про compute
      }
      if (s > 0.18) {
        add(
          'barrier',
          'Синхронизация (barrier) тормозит выполнение',
          '🧱',
          s,
          [
            `Barrier stall: <b>${fmtPct01(b)}</b>.`,
            `Стадия: <b>${stage.label}</b>.`,
          ],
          'Проверка: если это compute — попробуй убрать/реже делать `barrier()`/`GroupMemoryBarrier...` (на время эксперимента). GPU Duration должна уменьшиться.',
          [
            'Сократить число барьеров, объединять работу между барьерами.',
            'Использовать warp-level примитивы вместо block-level синхронизации, где возможно.',
            'Снизить размер группы (или изменить разбиение данных), чтобы уменьшить ожидание.',
          ]
        );
      }
    }

    // 9) Memory barriers / atomics
    {
      const mb = stalls.membar;
      let s = 0;
      if (Number.isFinite(mb)) {
        s = clamp01((mb - 0.06) / 0.25);
      }
      if (s > 0.18) {
        add(
          'membar',
          'Ожидание из-за atomics / memory barriers',
          '🧲',
          s,
          [
            `Membar stall: <b>${fmtPct01(mb)}</b>.`,
            Number.isFinite(writeRatio) ? `Доля записей в DRAM: <b>${fmtPct01(writeRatio)}</b>.` : '',
          ].filter(Boolean),
          'Проверка: убери атомики/фенсы (или замени на локальное накопление с редукцией) — время должно упасть.',
          [
            'Свести атомики к минимуму: делать редукцию в shared/warp, потом один атомик.',
            'Разбить данные так, чтобы уменьшить контеншн (меньше потоков пишут в один адрес).',
            'Избегать лишних memory fences.',
          ]
        );
      }
    }

    // 10) Instruction fetch / too large shader
    {
      const ni = stalls.noInstr;
      let s = 0;
      if (Number.isFinite(ni)) {
        s = clamp01((ni - 0.08) / 0.25);
      }
      if (s > 0.18) {
        add(
          'icache',
          'Проблема с выборкой инструкций (слишком большой/сложный шейдер)',
          '📜',
          s,
          [
            `No-instruction stall: <b>${fmtPct01(ni)}</b>.`,
            'Часто это связано с большим кодом (много вариантов, unroll, много функций).',
          ],
          'Проверка: отключи части шейдера (фичи/ветки), убери unroll — если `no_instruction` падает и время улучшается, проблема в размере/структуре кода.',
          [
            'Уменьшить размер шейдера: убрать лишние ветки, разделить на несколько проходов.',
            'Ограничить unroll и специализации, которые раздувают код.',
            'Переиспользовать общие функции, избегать дублирования.',
          ]
        );
      }
    }

    // 11) Shared memory bank conflicts
    {
      let s = 0;
      if (Number.isFinite(bankConfPerWf) && bankConfPerWf > 0) {
        s = clamp01((bankConfPerWf - CFG.BANKCONFLICT_HIGH) / 0.45);
        if (Number.isFinite(stalls.short)) s += 0.15 * clamp01((stalls.short - 0.10) / 0.25);
        if (Number.isFinite(bankConfP90) && bankConfP90 > 0) s += 0.10 * clamp01(((bankConfPerWf / bankConfP90) - 1.0) / 0.8);
      }
      if (s > 0.18) {
        add(
          'shmem',
          'Shared memory конфликтует (bank conflicts / сериализация)',
          '🏦',
          s,
          [
            `Bank conflicts per shared wavefront: <b>${bankConfPerWf.toFixed(2)}</b>${Number.isFinite(bankConfP90) ? ` (p90≈${bankConfP90.toFixed(2)})` : ''}.`,
            Number.isFinite(stalls.short) ? `Short scoreboard: <b>${fmtPct01(stalls.short)}</b>.` : '',
            `Shared bytes: ~ <b>${fmtMaybeGBps(utils, shBytes, timeNs)}</b>.`,
          ].filter(Boolean),
          'Проверка: попробуй поменять раскладку shared (padding/strides) или способ доступа — bank conflicts должны снизиться, и время уменьшится.',
          [
            'Добавить padding, чтобы разные потоки обращались к разным банкам.',
            'Сделать доступ более «линейным»: избегать адресов с одинаковыми нижними битами.',
            'Использовать vectorized loads/stores (например, float2/float4) где это уместно.',
          ]
        );
      }
    }

    // 12) Backend/output bound (fill/blend/depth) — proxy via subpackets + write ratio
    {
      let s = 0;
      if (Number.isFinite(backendWriteRate) && Number.isFinite(backendWriteRateP90) && backendWriteRateP90 > 0) {
        const rel = backendWriteRate / backendWriteRateP90;
        s = 0.65 * clamp01((rel - 0.85) / 0.40);
        if (Number.isFinite(writeRatio)) s += 0.35 * clamp01((writeRatio - 0.50) / 0.40);
        if (stage.kind !== 'PS') s *= 0.75;
      } else if (Number.isFinite(writeRatio) && writeRatio > CFG.WRITE_HEAVY) {
        s = 0.35 * clamp01((writeRatio - CFG.WRITE_HEAVY) / 0.35);
      }

      if (s > 0.18) {
        const which = (backend.zropW > backend.cropW) ? 'ZROP (depth/stencil)' : 'CROP (color/blend)';
        add(
          'backend',
          `Backend/ROP ограничивает скорость (${which})`,
          '🖍️',
          s,
          [
            Number.isFinite(backendWriteRate) && Number.isFinite(backendWriteRateP90)
              ? `Скорость записей (subpackets): ~ <b>${(backendWriteRate / backendWriteRateP90 * 100).toFixed(0)}%</b> от p90 по кадру.`
              : 'Скорость subpackets недоступна (нет baseline).',
            Number.isFinite(writeRatio) ? `Доля записей в DRAM: <b>${fmtPct01(writeRatio)}</b>.` : 'Доля записей: n/a.',
            utils.isNumber(samples) ? `Samples passed: <b>${fmtMaybeInt(utils, samples)}</b>.` : '',
          ].filter(Boolean),
          'Проверка: уменьшить разрешение или сократить площадь рисования (scissor/LOD/куллинг), отключить MSAA/blending — время должно падать почти пропорционально.',
          [
            'Снизить overdraw: сортировка по глубине, early-z, отбрасывание невидимого.',
            'Сократить количество render targets и/или перейти на более лёгкие форматы.',
            'Уменьшить MSAA/разрешение для этого прохода, использовать динамическое разрешение.',
          ]
        );
      }
    }

    // If nothing scored well, still provide a reasonable fallback based on top stalls
    if (candidates.length === 0) {
      const top = topStalls[0];
      const hint = top ? `Самый заметный stall: <b>${top.label}</b> (${fmtPct01(top.v)}).` : 'Данных мало.';
      add(
        'unknown',
        'Недостаточно данных для уверенного диагноза',
        '❓',
        0.12,
        [
          hint,
          'Убедись, что включены метрики из набора BoundDetectorAdvanced.metrics.renderdoc.json и повтори захват.'
        ],
        'Проверка: включи метрики, повтори захват, затем сравни несколько drawcall — где время больше и stall выше, там и узкое место.',
        [
          'Собрать метрики для проблемного кадра.',
          'Сравнить похожие drawcalls: что отличается (пиксели, текстуры, шейдер, RT).',
        ]
      );
    }

    // Pick best candidate
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1] || { score: 0 };

    let confidence = clamp01(best.score * 0.85 + coverage * 0.25 - Math.min(0.25, second.score * 0.35));
    if (!utils.isNumber(timeNs) || timeNs <= 0) confidence *= 0.5;

    // ------------------------------
    // Render UI
    // ------------------------------
    const root = document.createElement('div');
    root.style.padding = '10px';
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.gap = '10px';

    const card = document.createElement('div');
    card.style.border = '1px solid var(--border-color)';
    card.style.borderRadius = '8px';
    card.style.padding = '12px';
    card.style.background = 'var(--panel-bg-color, rgba(0,0,0,0.02))';

    // Header row
    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.gap = '10px';
    headerRow.style.alignItems = 'flex-start';

    const iconEl = document.createElement('div');
    iconEl.textContent = best.icon || '🧭';
    iconEl.style.fontSize = '24px';
    iconEl.style.lineHeight = '1';

    const titleCol = document.createElement('div');
    titleCol.style.flex = '1';

    const title = document.createElement('div');
    title.textContent = best.title;
    title.style.fontSize = '16px';
    title.style.fontWeight = '800';

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.flexWrap = 'wrap';
    meta.style.gap = '10px';
    meta.style.marginTop = '6px';
    meta.style.fontSize = '12px';
    meta.style.opacity = '0.85';

    const confLabel = document.createElement('span');
    confLabel.textContent = `Уверенность: ${(confidence * 100).toFixed(0)}%`;

    const stageLabel = document.createElement('span');
    stageLabel.innerHTML = `Стадия: <b>${stage.label}</b>`;

    const timeLabel = document.createElement('span');
    timeLabel.innerHTML = `GPU: <b>${fmtMaybeNs(utils, timeNs)}</b>`;

    const bwLabel = document.createElement('span');
    bwLabel.innerHTML = `DRAM BW: <b>${fmtMaybeGBps(utils, dramBytes, timeNs)}</b>`;

    meta.appendChild(confLabel);
    meta.appendChild(stageLabel);
    meta.appendChild(timeLabel);
    meta.appendChild(bwLabel);

    // top stalls quick glance
    if (topStalls.length) {
      const s = topStalls.map(x => `${x.label}: <b>${fmtPct01(x.v)}</b>`).join(' · ');
      const stallsLine = document.createElement('span');
      stallsLine.innerHTML = `Stalls: ${s}`;
      meta.appendChild(stallsLine);
    }

    titleCol.appendChild(title);
    titleCol.appendChild(meta);

    headerRow.appendChild(iconEl);
    headerRow.appendChild(titleCol);
    card.appendChild(headerRow);

    // Why section
    if (best.why && best.why.length) {
      const whyBox = document.createElement('div');
      whyBox.style.marginTop = '12px';
      whyBox.style.paddingTop = '10px';
      whyBox.style.borderTop = '1px solid var(--border-color)';

      const whyT = document.createElement('div');
      whyT.textContent = 'Почему я так думаю';
      whyT.style.fontWeight = '800';
      whyT.style.marginBottom = '6px';

      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      ul.style.lineHeight = '1.55';

      best.why.slice(0, 8).forEach((w) => {
        const li = document.createElement('li');
        li.innerHTML = w;
        ul.appendChild(li);
      });

      whyBox.appendChild(whyT);
      whyBox.appendChild(ul);
      card.appendChild(whyBox);
    }

    // Check section
    const checkBox = document.createElement('div');
    checkBox.style.marginTop = '12px';
    checkBox.style.paddingTop = '10px';
    checkBox.style.borderTop = '1px solid var(--border-color)';

    const checkT = document.createElement('div');
    checkT.textContent = 'Как быстро проверить';
    checkT.style.fontWeight = '800';
    checkT.style.marginBottom = '6px';

    const checkP = document.createElement('div');
    checkP.textContent = best.check || 'n/a';
    checkP.style.fontSize = '13px';
    checkP.style.lineHeight = '1.45';

    checkBox.appendChild(checkT);
    checkBox.appendChild(checkP);
    card.appendChild(checkBox);

    // Fix section
    const fixBox = document.createElement('div');
    fixBox.style.marginTop = '12px';
    fixBox.style.paddingTop = '10px';
    fixBox.style.borderTop = '1px solid var(--border-color)';

    const fixT = document.createElement('div');
    fixT.textContent = 'Что делать';
    fixT.style.fontWeight = '800';
    fixT.style.marginBottom = '6px';

    const fixes = (best.fix || []).slice(0, 6);
    if (fixes.length) {
      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      ul.style.lineHeight = '1.55';
      fixes.forEach((f) => {
        const li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      });
      fixBox.appendChild(fixT);
      fixBox.appendChild(ul);
    } else {
      const p = document.createElement('div');
      p.textContent = 'n/a';
      fixBox.appendChild(fixT);
      fixBox.appendChild(p);
    }

    card.appendChild(fixBox);

    root.appendChild(card);

    // Missing metrics hint
    makeMissingBox(root, missing);

    // Small hint
    const hint = document.createElement('div');
    hint.style.fontSize = '12px';
    hint.style.opacity = '0.75';
    hint.style.marginTop = '4px';
    hint.innerHTML = '💡 Подсказка: если причина связана с шейдером, включи в RenderDoc <b>Shader Debug</b> / <b>Shader Viewer</b> и проверь самые "дорогие" участки (циклы, ветки, выборки текстур, лишние записи).';
    root.appendChild(hint);

    container.appendChild(root);
  }

  PluginManager.register({
    id: TAB_ID,
    name: TAB_NAME,
    description: 'Диагноз bottleneck для выбранного drawcall/dispatch (работает на валидных counters).',
    order: TAB_ORDER,
    render
  });
})();
