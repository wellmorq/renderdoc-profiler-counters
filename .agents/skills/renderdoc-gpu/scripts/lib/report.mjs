// Self-contained HTML report for humans: pass timeline, marker tree, top events, shaders.
import fs from 'node:fs';
import path from 'node:path';
import { WORK_KINDS } from './case.mjs';
import { shaderRanking } from './query.mjs';
import { shaderStats, statsLabel } from './shaderstats.mjs';

export function writeReport(c, opts = {}) {
  const frame = c.frameMs() || 0;
  const nodes = [];
  const visit = (a, depth) => {
    const group = a.children > 0;
    if (!group && !WORK_KINDS.has(a.kind)) return;
    const ms = group ? c.nodeAgg(a).ms : c.ms(a.eid);
    const st = c.state.get(a.eid);
    nodes.push({
      e: a.eid, p: a.parent, d: depth, n: a.name, k: a.kind, ms: ms ?? null,
      ps: group ? undefined : c.get(a.eid, 'ps'), v: group ? undefined : c.get(a.eid, 'verts'),
      sh: st?.shaders ? (st.shaders.ps ?? st.shaders.cs) : undefined,
    });
    if (group) for (const k of c.kids(a)) visit(k, depth + 1);
  };
  for (const r of c.roots) visit(r, 0);
  const shaders = shaderRanking(c, { stages: ['ps', 'cs'] }).slice(0, 60).map((r) => {
    const s = c.shaderById.get(r.id) || {};
    return { id: r.id, stage: r.stage, ms: r.ms, uses: r.uses, name: s.name || '', stat: statsLabel(shaderStats(c, s)) };
  });
  const data = {
    title: path.basename(c.meta.capture || c.dir), api: c.info.api, vendor: c.info.vendor, frame, nodes, shaders,
    thumb: fs.existsSync(path.join(c.dir, 'thumbnail.png')) ? 'thumbnail.png' : null,
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPU capture report</title><style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--mut:#6b6b66;--line:#e4e3df;--bar:#3d6fd1;--bar2:#c7d5f3;--hi:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--mut:#9a9993;--line:#2c2c2a;--bar:#6f98ea;--bar2:#2b3a5a;--hi:#3a3220}}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px}
.mut{color:var(--mut)}table{border-collapse:collapse;width:100%}td,th{padding:3px 6px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
td.l,th.l{text-align:left}tr.g{cursor:pointer}tr.g td.n::before{content:'▸ ';color:var(--mut)}tr.g.o td.n::before{content:'▾ '}td.n{white-space:normal;min-width:280px}
tr:hover{background:var(--hi)}.b{height:8px;background:var(--bar);border-radius:2px}.bw{width:140px;background:var(--bar2);border-radius:2px}td.bc{width:150px}
input{font:inherit;padding:4px 8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:4px;width:260px}
.wrap{overflow-x:auto}header{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}img{max-width:280px;border:1px solid var(--line);border-radius:4px}
</style></head><body><main>
<div id="h"></div><h2>Marker tree <input id="q" placeholder="filter by name…"></h2><div class="wrap"><table id="t"></table></div>
<h2>Shaders by GPU time (ps/cs)</h2><div class="wrap"><table id="s"></table></div>
<script>const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const f=v=>v==null?'-':v>=10?v.toFixed(2):v>=.1?v.toFixed(3):v.toFixed(4);const pc=v=>D.frame&&v!=null?(v/D.frame*100).toFixed(1)+'%':'-';
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
document.getElementById('h').innerHTML='<header><div><h1>'+esc(D.title)+'</h1><div class="mut">'+esc(D.api)+' · '+esc(D.vendor)+' · '+f(D.frame)+' ms summed GPU time · '+D.nodes.filter(n=>n.k==='draw').length+' draws</div></div>'+(D.thumb?'<img src="'+D.thumb+'" alt="capture thumbnail">':'')+'</header>';
const kids=new Map();for(const n of D.nodes){if(!kids.has(n.p))kids.set(n.p,[]);kids.get(n.p).push(n)}
const open=new Set(D.nodes.filter(n=>n.d===0).map(n=>n.e));const T=document.getElementById('t');
function rows(q){let h='<tr><th class="l">name</th><th>eid</th><th>ms</th><th>%</th><th class="l"></th><th>ps inv</th><th>verts</th><th>shader</th></tr>';
const add=(n)=>{const g=kids.has(n.e);const vis=!q||n.n.toLowerCase().includes(q);if(vis)h+='<tr class="'+(g?'g':'')+(open.has(n.e)?' o':'')+'" data-e="'+n.e+'"><td class="l n" style="padding-left:'+(6+n.d*14)+'px">'+esc(n.n)+'</td><td>'+n.e+'</td><td>'+f(n.ms)+'</td><td>'+pc(n.ms)+'</td><td class="l"><div class="bw"><div class="b" style="width:'+(D.frame&&n.ms?Math.min(100,n.ms/D.frame*100):0)+'%"></div></div></td><td>'+(n.ps??'')+'</td><td>'+(n.v??'')+'</td><td>'+(n.sh??'')+'</td></tr>';
if(g&&(open.has(n.e)||q))for(const k of kids.get(n.e))add(k)};for(const r of kids.get(0)||[])add(r);T.innerHTML=h}
T.onclick=e=>{const tr=e.target.closest('tr.g');if(!tr)return;const id=+tr.dataset.e;open.has(id)?open.delete(id):open.add(id);rows(document.getElementById('q').value.toLowerCase())};
document.getElementById('q').oninput=e=>rows(e.target.value.toLowerCase());rows('');
document.getElementById('s').innerHTML='<tr><th>id</th><th class="l">stage</th><th>ms</th><th>%</th><th>uses</th><th class="l">static</th><th class="l">name</th></tr>'+D.shaders.map(s=>'<tr><td>'+s.id+'</td><td class="l">'+s.stage+'</td><td>'+f(s.ms)+'</td><td>'+pc(s.ms)+'</td><td>'+s.uses+'</td><td class="l">'+esc(s.stat)+'</td><td class="l">'+esc(s.name)+'</td></tr>').join('');
</script></main></body></html>`;
  const file = path.resolve(opts.out || path.join(c.dir, 'report.html'));
  fs.writeFileSync(file, html);
  return `report: ${file}`;
}
