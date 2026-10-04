#!/usr/bin/env node
// renderdoc-gpu: RenderDoc capture analysis CLI for agents. Run without arguments for help.
import { parseArgs } from 'node:util';
import { loadCase } from './lib/case.mjs';
import { compare } from './lib/compare.mjs';
import { findSource } from './lib/findsource.mjs';
import { importLegacy } from './lib/legacy.mjs';
import * as live from './lib/live.mjs';
import { fetchCounters, openCapture } from './lib/prepare.mjs';
import { presetHelp } from './lib/presets.mjs';
import * as q from './lib/query.mjs';
import { writeReport } from './lib/report.mjs';
import { doctor, setupNvPerf } from './lib/setup.mjs';

const HELP = `renderdoc-gpu — analyze RenderDoc GPU captures (.rdc) from the command line

SETUP
  doctor [--capture <rdc>]            check RenderDoc, headless Python host, Nsight Perf SDK, counters
  setup-nvperf [--from <zip|dir|dll>] install nvperf_grfx_host for RenderDoc's NVIDIA counters

PREPARE (runs RenderDoc once, caches everything next to the capture as <capture>.rdgpu/)
  open <rdc> [--counters <sets>] [--repeat N] [--no-state] [--no-shaders] [--state-limit N] [--force]
  fetch <rdc> <sets|names|re:regex> [--repeat N]   add counters to a prepared case
  import <dir-with-txt+csv>           legacy: RenderDoc UI "Event Browser" TXT + counters CSV export

QUERY (offline, instant)
  summary <rdc>                       frame overview, top passes/events/shaders
  tree <rdc> [marker|eid|.] [--depth N] [--top N] [--min-pct P] [--metrics a,b]
  top <rdc> [--by <metric>] [--in <marker|eid>] [--kind draw,dispatch] [-n N]
  event <rdc> <eid>                   counters, derived ratios, pipeline state, bound textures
  shaders <rdc> [--stage ps,cs] [--in <marker>] [-n N]
  shader <rdc> <shader-id>            reflection, flags, disassembly/source paths, users
  find <rdc> <text>                   markers, shaders (cbuffer/texture names), textures
  metrics <rdc> [filter]              collected + available counters with descriptions
  compare <before.rdc> <after.rdc> [marker] [--depth N]
  find-source <rdc> <shader-id> --project <dir>   rank project shader files by identifier overlap
  report <rdc>                        write an interactive HTML report

LIVE (replays the capture; seconds to minutes)
  draw <rdc> <eid> [--all]            constant-buffer values, texture slots, targets
  rt <rdc> <eid> [--depth|--all]      save render target(s) after the event as PNG
  usage <rdc> <resource-id>           which events read/write a resource
  source <rdc> <eid> [--stage ps] [--as name]     dump the shader's embedded source; --as makes a named editable copy
  experiment <rdc> <eid> [--stage ps] [--variant label=path/main.hlsl]... [--counters names]
             [--repeat N] [--flags-remove /Od] [--flags-add /O3] [--images] [--no-original]
             replace the shader in the replay, measure every variant against the original

COUNTER SETS for --counters / fetch (comma separated; also exact names or re:<regex>):
${presetHelp()}
  default for open: generic,nv-pack (vendor sets resolve to nothing on other GPUs)

COMMON  --json (where supported) --timeout <sec> --host qrenderdoc|python
ENV     RDGPU_RENDERDOC=<qrenderdoc dir>  RENDERDOC_PYTHON_PATH=<dir with renderdoc module> RDGPU_PYTHON=<python>
        RDGPU_CASES=<dir> to keep caches outside the capture folder`;

const OPTIONS = {
  json: { type: 'boolean' },
  force: { type: 'boolean' },
  counters: { type: 'string' },
  repeat: { type: 'string' },
  'no-state': { type: 'boolean' },
  'no-shaders': { type: 'boolean' },
  'state-limit': { type: 'string' },
  depth: { type: 'string' },
  top: { type: 'string' },
  'min-pct': { type: 'string' },
  metrics: { type: 'string' },
  by: { type: 'string' },
  in: { type: 'string' },
  kind: { type: 'string' },
  n: { type: 'string', short: 'n' },
  stage: { type: 'string' },
  out: { type: 'string' },
  variant: { type: 'string', multiple: true },
  'flags-remove': { type: 'string', multiple: true },
  'flags-add': { type: 'string', multiple: true },
  images: { type: 'boolean' },
  'no-original': { type: 'boolean' },
  encoding: { type: 'string' },
  entry: { type: 'string' },
  all: { type: 'boolean' },
  project: { type: 'string' },
  from: { type: 'string' },
  capture: { type: 'string' },
  timeout: { type: 'string' },
  host: { type: 'string' },
  label: { type: 'string' },
  as: { type: 'string' },
  resource: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const num = (v, d) => (v === undefined ? d : Number(v));

function parseDepthFlag(values) {
  // `--depth` doubles as "depth target" for rt and a number for tree
  return values.depth;
}

async function main() {
  const argv = process.argv.slice(2);
  // allow bare `--depth` for rt
  const fixed = argv.map((a, i) => (a === '--depth' && (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) ? '--depth=1' : a));
  const { values: o, positionals: p } = parseArgs({ args: fixed, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...args] = p;
  if (!cmd || o.help || cmd === 'help') { console.log(HELP); return; }
  const common = { timeout: o.timeout ? Number(o.timeout) : undefined, host: o.host, verbose: o.verbose };
  const need = (n, what) => { if (args.length < n) throw new Error(`usage: ${cmd} ${what}`); };
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

  switch (cmd) {
    case 'doctor': {
      const r = await doctor({ ...common, capture: o.capture || args[0] });
      out(r.text);
      process.exitCode = r.ready ? 0 : 2;
      return;
    }
    case 'setup-nvperf': {
      const r = setupNvPerf({ from: o.from || args[0] });
      out(r.text);
      process.exitCode = r.ok ? 0 : 2;
      return;
    }
    case 'open': {
      need(1, '<capture.rdc>');
      const r = await openCapture(args[0], {
        ...common, force: o.force, counters: o.counters, repeat: num(o.repeat, 1),
        noState: o['no-state'], noShaders: o['no-shaders'], stateLimit: num(o['state-limit'], 0),
      });
      const c = loadCase(r.dir);
      out(`case: ${r.dir}${r.reused ? ' (cached)' : ` (extracted in ${r.meta.seconds}s)`}\n`);
      out(o.json ? JSON.stringify({ dir: r.dir, info: { api: c.info.api, vendor: c.info.vendor }, frameMs: c.frameMs() }) : q.summary(c, { n: num(o.n, 8) }));
      return;
    }
    case 'fetch': {
      need(2, '<capture> <counter sets|names>');
      const r = await fetchCounters(args[0], args.slice(1).join(','), { ...common, repeat: num(o.repeat, 1), label: o.label });
      out(`fetched ${r.fetched} counters for ${r.events ?? 0} events${r.missing?.length ? `; missing: ${r.missing.join(', ')}` : ''}`);
      return;
    }
    case 'import': {
      need(1, '<directory with RenderDoc TXT + CSV exports>');
      const dir = importLegacy(args[0], { out: o.out });
      out(`case: ${dir}\n`);
      out(q.summary(loadCase(dir), { n: num(o.n, 8) }));
      return;
    }
    case 'summary': need(1, '<capture>'); out(q.summary(loadCase(args[0]), { n: num(o.n, 8) })); return;
    case 'tree': {
      need(1, '<capture> [marker|eid]');
      const c = loadCase(args[0]);
      out(q.tree(c, args[1], { depth: num(o.depth, 2), top: num(o.top, 12), minPct: num(o['min-pct'], 0), metrics: o.metrics ? o.metrics.split(',') : [] }));
      return;
    }
    case 'top': {
      need(1, '<capture>');
      const c = loadCase(args[0]);
      const within = o.in ? c.findNodes(o.in).flatMap((n) => c.workUnder(n)) : null;
      if (o.in && !within.length) throw new Error(`No marker/event matches "${o.in}"`);
      out(q.topTable(c, { n: num(o.n, 20), by: o.by || 'ms', within, kinds: o.kind ? o.kind.split(',') : undefined }));
      return;
    }
    case 'event': need(2, '<capture> <eid>'); out(q.event(loadCase(args[0]), Number(args[1]))); return;
    case 'shaders': {
      need(1, '<capture>');
      const c = loadCase(args[0]);
      out(q.shaders(c, { stage: o.stage, n: num(o.n, 25), within: o.in ? c.findNodes(o.in) : null }));
      return;
    }
    case 'shader': need(2, '<capture> <shader-id>'); out(q.shader(loadCase(args[0]), args[1])); return;
    case 'find': need(2, '<capture> <text>'); out(q.find(loadCase(args[0]), args.slice(1).join(' '))); return;
    case 'metrics': need(1, '<capture> [filter]'); out(q.metrics(loadCase(args[0]), args[1])); return;
    case 'compare': {
      need(2, '<before> <after> [marker]');
      out(compare(loadCase(args[0]), loadCase(args[1]), args[2], { depth: num(o.depth, 2), n: num(o.n, 25), metrics: o.metrics ? o.metrics.split(',') : null }));
      return;
    }
    case 'find-source': {
      need(2, '<capture> <shader-id> --project <dir>');
      if (!o.project) throw new Error('--project <unity project or shader source root> is required');
      out(findSource(loadCase(args[0]), args[1], o.project, { n: num(o.n, 8) }));
      return;
    }
    case 'report': need(1, '<capture>'); out(writeReport(loadCase(args[0]), { out: o.out })); return;
    case 'draw': need(2, '<capture> <eid>'); out(await live.draw(loadCase(args[0]), Number(args[1]), { ...common, all: o.all })); return;
    case 'rt': need(2, '<capture> <eid>'); out(await live.rt(loadCase(args[0]), Number(args[1]), { ...common, depth: !!parseDepthFlag(o), all: o.all, resource: o.resource })); return;
    case 'usage': need(2, '<capture> <resource-id>'); out(await live.usage(loadCase(args[0]), Number(args[1]), { ...common, n: num(o.n, 60) })); return;
    case 'source': need(2, '<capture> <eid>'); out(await live.source(loadCase(args[0]), Number(args[1]), { ...common, stage: o.stage, out: o.out, as: o.as })); return;
    case 'experiment': {
      need(2, '<capture> <eid> --variant label=file ...');
      out(await live.experiment(loadCase(args[0]), Number(args[1]), {
        ...common, stage: o.stage, variant: o.variant, counters: o.counters, repeat: num(o.repeat, 5),
        flagsRemove: o['flags-remove'], flagsAdd: o['flags-add'], images: o.images, noOriginal: o['no-original'],
        encoding: o.encoding, entry: o.entry,
      }));
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}". Run without arguments for help.`);
  }
}

main().catch((e) => {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exitCode = 1;
});
