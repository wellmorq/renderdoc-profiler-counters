# RenderDoc-side job runner for the renderdoc-gpu skill.
#
# Runs inside RenderDoc's Python: either the interpreter embedded in
# qrenderdoc (`qrenderdoc --python rdjob.py`, Python 3.6 on Windows builds) or a
# standalone interpreter that can import the `renderdoc` module. Keep the code
# Python 3.6 compatible: no dataclasses, no walrus, no f-string "=".
#
# The job description is a JSON file named by $RDGPU_JOB (or argv[1]). Every
# task writes its own output files; a final result JSON is always written,
# also on failure, and the script always ends with SystemExit so qrenderdoc
# never opens its main window.

import json
import os
import re
import sys
import time
import traceback

JOB = None
PROGRESS = None
T0 = time.time()


def log(msg):
    line = "[%7.1fs] %s" % (time.time() - T0, msg)
    if PROGRESS is not None:
        try:
            PROGRESS.write(line + "\n")
            PROGRESS.flush()
        except Exception:
            pass


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    if os.path.exists(path):
        os.remove(path)
    os.rename(tmp, path)


def write_text(path, text):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def ename(v):
    n = getattr(v, "name", None)
    if isinstance(n, str) and n:
        return n
    s = str(v)
    return s.split(".")[-1] if "." in s else s


def rid(v):
    try:
        return int(v)
    except Exception:
        return 0


def res_of(d):
    """Resource id from a Descriptor / BoundResource / UsedDescriptor across API versions."""
    if d is None:
        return 0
    for attr in ("resource", "resourceId"):
        if hasattr(d, attr):
            return rid(getattr(d, attr))
    if hasattr(d, "descriptor"):
        return res_of(d.descriptor)
    return 0


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


# ---------------------------------------------------------------- setup

def import_rd():
    mod_dir = os.environ.get("RENDERDOC_PYTHON_PATH")
    if mod_dir and "renderdoc" not in sys.modules:
        sys.path.insert(0, mod_dir)
        if hasattr(os, "add_dll_directory"):
            # Windows + Python 3.8+: renderdoc.dll is resolved via explicit DLL dirs only
            for d in (mod_dir, os.path.dirname(mod_dir)):
                if os.path.isfile(os.path.join(d, "renderdoc.dll")):
                    os.add_dll_directory(d)  # novermin (guarded by hasattr)
    import renderdoc as rd  # noqa
    return rd


def open_capture(rd, path, in_ui):
    if not in_ui:
        rd.InitialiseReplay(rd.GlobalEnvironment(), [])
    cap = rd.OpenCaptureFile()
    res = cap.OpenFile(path, "", None)
    ok = res.OK() if hasattr(res, "OK") else res == rd.ResultCode.Succeeded
    if not ok:
        raise RuntimeError("Could not open capture file %s: %s" % (path, safe(lambda: res.Message(), str(res))))
    support = cap.LocalReplaySupport()
    if support != rd.ReplaySupport.Supported:
        raise RuntimeError(
            "Capture cannot be replayed on this machine (%s). Driver at capture time: %s. "
            "Replay needs the same graphics API and a compatible GPU/driver." % (ename(support), safe(cap.DriverName, "?")))
    opts = rd.ReplayOptions()
    state = {"last": -1.0}

    def progress(p):
        if p - state["last"] >= 0.1 or p >= 1.0:
            state["last"] = p
            log("loading capture %d%%" % int(p * 100))

    log("opening capture %s" % path)
    result = cap.OpenCapture(opts, progress)
    if isinstance(result, tuple):
        status, controller = result
    else:
        status, controller = rd.ResultCode.Succeeded, result
    ok = status.OK() if hasattr(status, "OK") else status == rd.ResultCode.Succeeded
    if not ok or controller is None:
        raise RuntimeError("Could not replay capture: %s" % safe(lambda: status.Message(), str(status)))
    log("capture loaded")
    return cap, controller


# ---------------------------------------------------------------- shared helpers

class Ctx(object):
    def __init__(self, rd, cap, controller, out):
        self.rd = rd
        self.cap = cap
        self.c = controller
        self.out = out
        self.sdfile = safe(controller.GetStructuredFile)
        self._catalog = None
        self._names = None
        self._actions = None

    def names(self):
        if self._names is None:
            self._names = {}
            self._res = {}
            for r in self.c.GetResources():
                self._names[rid(r.resourceId)] = r.name
                self._res[rid(r.resourceId)] = r
        return self._names

    def display_name(self, i):
        """Resource name; for auto-named shaders fall back to a named parent (GL program, PSO)."""
        names = self.names()
        r = self._res.get(i)
        if r is None:
            return names.get(i, "")
        if not getattr(r, "autogeneratedName", False):
            return r.name
        for p in list(getattr(r, "parentResources", []) or []):
            pr = self._res.get(rid(p))
            if pr is not None and not getattr(pr, "autogeneratedName", True):
                return pr.name
        return r.name

    def catalog(self):
        if self._catalog is None:
            rd = self.rd
            cat = []
            for ctr in self.c.EnumerateCounters():
                d = self.c.DescribeCounter(ctr)
                cat.append({
                    "id": int(ctr),
                    "name": d.name,
                    "unit": ename(d.unit),
                    "category": d.category,
                    "description": d.description,
                    "resultType": ename(d.resultType),
                    "byteWidth": int(d.resultByteWidth),
                    "family": counter_family(rd, int(ctr)),
                })
            self._catalog = cat
        return self._catalog

    def action_name(self, a):
        if self.sdfile is not None and hasattr(a, "GetName"):
            return a.GetName(self.sdfile)
        return getattr(a, "customName", "") or getattr(a, "name", "")

    def actions(self):
        """Flattened action list in replay order: (action, parentEid, depth, path)."""
        if self._actions is None:
            roots = self.c.GetRootActions() if hasattr(self.c, "GetRootActions") else self.c.GetDrawcalls()
            flat = []

            def walk(lst, parent, depth, path):
                for a in lst:
                    name = self.action_name(a)
                    flat.append((a, parent, depth, path, name))
                    if len(a.children) > 0:
                        walk(a.children, a.eventId, depth + 1, path + [name])
            walk(roots, 0, 0, [])
            self._actions = flat
        return self._actions

    def work_actions(self, kinds=("draw", "dispatch")):
        return [x for x in self.actions() if action_kind(self.rd, x[0].flags) in kinds]


def counter_family(rd, cid):
    G = rd.GPUCounter
    def val(name, dflt):
        return int(getattr(G, name, dflt))
    if cid < val("FirstAMD", 1000000):
        return "generic"
    if cid < val("FirstIntel", 2000000):
        return "amd"
    if cid < val("FirstNvidia", 3000000):
        return "intel"
    if cid < val("FirstVulkanExtended", 4000000):
        return "nvidia"
    if cid < val("FirstARM", 5000000):
        return "vulkan-ext"
    return "arm"


FLAG_NAMES = ["Clear", "Drawcall", "Dispatch", "MeshDispatch", "CmdList", "SetMarker", "PushMarker",
              "PopMarker", "Present", "MultiAction", "Copy", "Resolve", "GenMips", "PassBoundary",
              "DispatchRay", "BuildAccStruct", "Indexed", "Instanced", "Auto", "Indirect",
              "ClearColor", "ClearDepthStencil", "BeginPass", "EndPass", "CommandBufferBoundary"]


def flag_list(rd, flags):
    out = []
    for n in FLAG_NAMES:
        f = getattr(rd.ActionFlags, n, None)
        if f is not None and int(f) != 0 and (int(flags) & int(f)) == int(f):
            out.append(n)
    return out


def has_flag(rd, flags, name):
    f = getattr(rd.ActionFlags, name, None)
    return f is not None and (int(flags) & int(f)) != 0


def action_kind(rd, flags):
    if has_flag(rd, flags, "Drawcall") or has_flag(rd, flags, "MeshDispatch"):
        return "draw"
    if has_flag(rd, flags, "Dispatch") or has_flag(rd, flags, "DispatchRay"):
        return "dispatch"
    if has_flag(rd, flags, "Clear"):
        return "clear"
    if has_flag(rd, flags, "Copy") or has_flag(rd, flags, "Resolve") or has_flag(rd, flags, "GenMips"):
        return "copy"
    if has_flag(rd, flags, "Present"):
        return "present"
    if has_flag(rd, flags, "PushMarker"):
        return "marker"
    if has_flag(rd, flags, "SetMarker"):
        return "label"
    if has_flag(rd, flags, "PassBoundary") or has_flag(rd, flags, "BeginPass") or has_flag(rd, flags, "EndPass"):
        return "pass"
    return "other"


def counter_value(desc, v):
    t = desc["resultType"]
    w = desc["byteWidth"]
    if t == "Float":
        return float(v.d) if w == 8 else float(v.f)
    if w == 8:
        return int(v.u64)
    return int(v.u32)


def tex_info(ctx, tid):
    if tid == 0:
        return None
    if not hasattr(ctx, "_texmap"):
        ctx._texmap = {}
        for t in ctx.c.GetTextures():
            ctx._texmap[rid(t.resourceId)] = t
    t = ctx._texmap.get(tid)
    if t is None:
        return {"id": tid, "name": ctx.names().get(tid, "")}
    return {"id": tid, "name": ctx.names().get(tid, ""), "w": int(t.width), "h": int(t.height),
            "d": int(t.depth), "mips": int(t.mips), "arr": int(t.arraysize),
            "fmt": safe(lambda: t.format.Name(), ""), "ms": int(t.msSamp)}


# ---------------------------------------------------------------- tasks

def task_info(ctx, task):
    rd, c = ctx.rd, ctx.c
    props = c.GetAPIProperties()
    info = {
        "renderdocVersion": safe(rd.GetVersionString, ""),
        "renderdocCommit": safe(rd.GetCommitHash, ""),
        "python": sys.version.split()[0],
        "api": ename(props.pipelineType),
        "localRenderer": ename(props.localRenderer),
        "vendor": ename(props.vendor),
        "degraded": bool(props.degraded),
        "shaderDebugging": bool(getattr(props, "shaderDebugging", False)),
        "pixelHistory": bool(getattr(props, "pixelHistory", False)),
        "driverAtCapture": safe(ctx.cap.DriverName, ""),
        "machineAtCapture": safe(ctx.cap.RecordedMachineIdent, ""),
    }
    drv = safe(lambda: c.GetDriverInformation())
    if drv is not None:
        info["replayDriver"] = {"vendor": ename(drv.vendor), "version": safe(lambda: str(drv.version), "")}
    fi = safe(c.GetFrameInfo)
    if fi is not None:
        info["frame"] = {"frameNumber": int(fi.frameNumber),
                         "captureTime": int(getattr(fi, "captureTime", 0)),
                         "compressedFileSize": int(getattr(fi, "compressedFileSize", 0))}
    info["disassemblyTargets"] = list(safe(lambda: c.GetDisassemblyTargets(True), []) or [])
    info["targetShaderEncodings"] = [ename(e) for e in (safe(c.GetTargetShaderEncodings, []) or [])]
    texs = []
    for t in c.GetTextures():
        i = tex_info(ctx, rid(t.resourceId))
        i["flags"] = ename(t.creationFlags)
        i["bytes"] = int(getattr(t, "byteSize", 0))
        texs.append(i)
    info["textures"] = texs
    info["bufferCount"] = len(c.GetBuffers())
    info["resourceCount"] = len(c.GetResources())
    msgs = safe(c.GetDebugMessages, []) or []
    info["debugMessages"] = [{"eid": int(m.eventId), "severity": ename(m.severity), "text": m.description[:400]}
                             for m in list(msgs)[:200]]
    info["counters"] = ctx.catalog()
    nv_note = [x["name"] for x in info["counters"] if x["name"].startswith("ERROR:")]
    if nv_note:
        info["counterErrors"] = nv_note
    write_json(os.path.join(ctx.out, "info.json"), info)
    thumb = task.get("thumbnail")
    if thumb:
        try:
            th = ctx.cap.GetThumbnail(rd.FileType.PNG, 1024)
            data = bytes(th.data)
            if data:
                with open(os.path.join(ctx.out, "thumbnail.png"), "wb") as f:
                    f.write(data)
        except Exception as e:
            log("thumbnail failed: %s" % e)
    log("info: api=%s vendor=%s counters=%d textures=%d" % (info["api"], info["vendor"], len(info["counters"]), len(texs)))
    return {"counters": len(info["counters"]), "api": info["api"]}


def task_actions(ctx, task):
    rd = ctx.rd
    rows = []
    for a, parent, depth, path, name in ctx.actions():
        kind = action_kind(rd, a.flags)
        row = {"eid": int(a.eventId), "parent": int(parent), "depth": depth, "name": name, "kind": kind,
               "flags": flag_list(rd, a.flags), "children": len(a.children)}
        if kind == "draw":
            row["indices"] = int(a.numIndices)
            row["instances"] = int(a.numInstances)
        if kind == "dispatch":
            row["groups"] = [int(x) for x in a.dispatchDimension]
            tdim = [int(x) for x in getattr(a, "dispatchThreadsDimension", [0, 0, 0])]
            if any(tdim):
                row["threads"] = tdim
        outs = [rid(o) for o in a.outputs if rid(o) != 0]
        if outs:
            row["outputs"] = outs
        if rid(a.depthOut):
            row["depthOut"] = rid(a.depthOut)
        if kind == "copy":
            src, dst = rid(getattr(a, "copySource", 0)), rid(getattr(a, "copyDestination", 0))
            if src:
                row["copySrc"] = src
            if dst:
                row["copyDst"] = dst
        if len(a.events) > 1:
            row["apiCalls"] = len(a.events)
        if len(a.children) > 0:
            row["lastEid"] = int(a.children[-1].eventId)
        rows.append(row)
    with open(os.path.join(ctx.out, "actions.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
    log("actions: %d" % len(rows))
    return {"actions": len(rows)}


def resolve_counters(ctx, names):
    cat = ctx.catalog()
    by_name = {}
    for x in cat:
        by_name[x["name"].lower()] = x
    found, missing = [], []
    for n in names:
        x = by_name.get(n.lower())
        if x is None:
            missing.append(n)
        elif x not in found:
            found.append(x)
    return found, missing


def fetch(ctx, descs, chunk):
    """Fetch counters, chunked. Returns {eid: {name: value}}."""
    rd = ctx.rd
    data = {}
    for i in range(0, len(descs), chunk):
        part = descs[i:i + chunk]
        log("fetching counters %d-%d of %d (%s%s)" % (i + 1, i + len(part), len(descs), part[0]["name"],
                                                      ", ..." if len(part) > 1 else ""))
        t = time.time()
        results = ctx.c.FetchCounters([rd.GPUCounter(x["id"]) for x in part])
        by_id = dict((x["id"], x) for x in part)
        for r in results:
            d = by_id.get(int(r.counter))
            if d is None:
                continue
            data.setdefault(int(r.eventId), {})[d["name"]] = counter_value(d, r.value)
        log("  done in %.1fs, %d results" % (time.time() - t, len(results)))
    return data


def median(vals):
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def task_counters(ctx, task):
    """Fetch counters by exact name, or all of a family. Output: counters-<label>.json."""
    cat = ctx.catalog()
    names = list(task.get("names") or [])
    for fam in task.get("families") or []:
        names += [x["name"] for x in cat if x["family"] == fam and not x["name"].startswith("ERROR:")]
    for pat in task.get("patterns") or []:
        rx = re.compile(pat, re.I)
        names += [x["name"] for x in cat if rx.search(x["name"]) and not x["name"].startswith("ERROR:")]
    descs, missing = resolve_counters(ctx, names)
    repeat = int(task.get("repeat", 1))
    chunk = int(task.get("chunk", 64))
    label = task.get("label", "counters")
    if not descs:
        log("counters[%s]: nothing to fetch (missing: %s)" % (label, ", ".join(missing[:10])))
        out = {"label": label, "counters": [], "missing": missing, "data": []}
        write_json(os.path.join(ctx.out, "counters-%s.json" % label), out)
        return {"fetched": 0, "missing": missing}
    runs = []
    for r in range(repeat):
        if repeat > 1:
            log("counter run %d/%d" % (r + 1, repeat))
        runs.append(fetch(ctx, descs, chunk))
    merged = {}
    spread = {}
    for eid in runs[0]:
        merged[eid] = {}
        for d in descs:
            vals = [run.get(eid, {}).get(d["name"]) for run in runs]
            vals = [v for v in vals if v is not None]
            if not vals:
                continue
            merged[eid][d["name"]] = median(vals)
            if repeat > 1 and d["unit"] == "Seconds":
                spread.setdefault(eid, {})[d["name"]] = [min(vals), max(vals)]
    cols = [d["name"] for d in descs]
    rows = []
    for eid in sorted(merged):
        rows.append([eid] + [merged[eid].get(n) for n in cols])
    out = {"label": label, "counters": cols, "units": [d["unit"] for d in descs], "missing": missing,
           "repeat": repeat, "data": rows}
    if spread:
        out["spread"] = dict((str(k), v) for k, v in spread.items())
    write_json(os.path.join(ctx.out, "counters-%s.json" % label), out)
    log("counters[%s]: %d counters x %d events" % (label, len(cols), len(rows)))
    return {"fetched": len(cols), "missing": missing, "events": len(rows)}


STAGES = [("vs", "Vertex"), ("hs", "Hull"), ("ds", "Domain"), ("gs", "Geometry"), ("ps", "Pixel"),
          ("cs", "Compute"), ("as", "Amplification"), ("ms", "Mesh")]


def stage_enum(rd, short):
    for s, n in STAGES:
        if s == short:
            return getattr(rd.ShaderStage, n)
    raise ValueError("unknown stage %s" % short)


def collect_state(ctx, a, shaders_seen):
    rd, c = ctx.rd, ctx.c
    c.SetFrameEvent(a.eventId, False)
    pipe = c.GetPipelineState()
    kind = action_kind(rd, a.flags)
    st = {"eid": int(a.eventId)}
    sh = {}
    stages = [("cs", "Compute")] if kind == "dispatch" else [x for x in STAGES if x[0] != "cs"]
    if kind == "dispatch":
        pipeline = rid(safe(pipe.GetComputePipelineObject, 0))
    else:
        pipeline = rid(safe(pipe.GetGraphicsPipelineObject, 0))
    for short, name in stages:
        stage = getattr(rd.ShaderStage, name, None)
        if stage is None:
            continue
        sid = rid(safe(lambda: pipe.GetShader(stage), 0))
        if not sid:
            continue
        entry = safe(lambda: pipe.GetShaderEntryPoint(stage), "") or ""
        sh[short] = sid
        key = (sid, entry)
        if key not in shaders_seen:
            refl = safe(lambda: pipe.GetShaderReflection(stage))
            if refl is not None:
                shaders_seen[key] = {"pipeline": pipeline, "refl": refl, "stage": short, "firstEid": int(a.eventId)}
        # bound textures for this stage
        ro = safe(lambda: pipe.GetReadOnlyResources(stage, True), []) or []
        ids = []
        for u in ro:
            r = res_of(u)
            if r and r not in ids:
                ids.append(r)
        if ids:
            st.setdefault("srv", {})[short] = ids
        rw = safe(lambda: pipe.GetReadWriteResources(stage, True), []) or []
        ids = []
        for u in rw:
            r = res_of(u)
            if r and r not in ids:
                ids.append(r)
        if ids:
            st.setdefault("uav", {})[short] = ids
    st["shaders"] = sh
    if pipeline:
        st["pipeline"] = pipeline
    if kind == "draw":
        st["topology"] = ename(safe(pipe.GetPrimitiveTopology, ""))
        vp = safe(lambda: pipe.GetViewport(0))
        if vp is not None:
            st["viewport"] = [round(vp.x, 2), round(vp.y, 2), round(vp.width, 2), round(vp.height, 2)]
        rts = [res_of(d) for d in (safe(pipe.GetOutputTargets, []) or [])]
        rts = [r for r in rts if r]
        if rts:
            st["rts"] = rts
        dt = res_of(safe(pipe.GetDepthTarget))
        if dt:
            st["depthTarget"] = dt
        blends = safe(pipe.GetColorBlends, []) or []
        if len(blends) > 0:
            st["blend"] = [bool(b.enabled) for b in list(blends)[:max(1, len(rts))]]
            b0 = blends[0]
            if b0.enabled:
                st["blendEq"] = "%s*%s %s %s*%s" % (ename(b0.colorBlend.source), "src", ename(b0.colorBlend.operation),
                                                   ename(b0.colorBlend.destination), "dst")
        ds = safe(pipe.GetDepthTestState)
        if ds is not None:
            st["depth"] = {"test": bool(ds.depthEnable), "write": bool(ds.depthWrites), "func": ename(ds.depthFunction)}
        rs = safe(pipe.GetRasterState)
        if rs is not None:
            st["cull"] = ename(rs.cullMode)
            st["fill"] = ename(rs.fillMode)
        st["stencil"] = bool(safe(pipe.IsStencilTestEnabled, False))
        vin = safe(pipe.GetVertexInputs, []) or []
        st["vertexInputs"] = len([v for v in vin if getattr(v, "used", True)])
        vbs = safe(pipe.GetVBuffers, []) or []
        strides = [int(v.byteStride) for v in vbs if rid(getattr(v, "resourceId", 0))]
        if strides:
            st["vbStrides"] = strides
    return st


def task_state(ctx, task):
    rd = ctx.rd
    acts = ctx.work_actions()
    limit = int(task.get("limit", 0))
    if limit and len(acts) > limit:
        log("state: limiting to first %d of %d work actions" % (limit, len(acts)))
        acts = acts[:limit]
    seen = {}
    ctx._shaders_seen = seen
    rows = []
    t = time.time()
    for i, x in enumerate(acts):
        a = x[0]
        try:
            rows.append(collect_state(ctx, a, seen))
        except Exception as e:
            rows.append({"eid": int(a.eventId), "error": str(e)})
        if (i + 1) % 100 == 0 or i + 1 == len(acts):
            log("state %d/%d (%.1fs)" % (i + 1, len(acts), time.time() - t))
    with open(os.path.join(ctx.out, "state.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    # resources referenced by state: names & sizes for the textures we saw
    ids = set()
    for r in rows:
        for k in ("rts",):
            ids.update(r.get(k, []))
        if r.get("depthTarget"):
            ids.add(r["depthTarget"])
        for part in ("srv", "uav"):
            for v in r.get(part, {}).values():
                ids.update(v)
    res = {}
    for i in ids:
        ti = tex_info(ctx, i)
        if ti is not None:
            if "w" not in ti:
                ti["name"] = ctx.names().get(i, "")
            res[str(i)] = ti
    write_json(os.path.join(ctx.out, "resources.json"), res)
    return {"events": len(rows), "shaders": len(seen)}


def flatten_constants(consts, prefix="", out=None, depth=0):
    if out is None:
        out = []
    for v in consts:
        name = prefix + v.name
        t = v.type
        members = list(getattr(t, "members", []) or [])
        elems = int(getattr(t, "elements", 1))
        if members and depth < 3:
            flatten_constants(members, name + ("[]." if elems > 1 else "."), out, depth + 1)
        else:
            out.append({"name": name, "offset": int(getattr(v, "byteOffset", 0)),
                        "type": "%s%dx%d" % (ename(getattr(t, "baseType", "")), int(getattr(t, "rows", 1)),
                                              int(getattr(t, "columns", 1))),
                        "elements": elems})
    return out


def shader_meta(ctx, sid, entry, info):
    rd = ctx.rd
    refl = info["refl"]
    dbg = refl.debugInfo
    meta = {
        "id": sid,
        "name": ctx.display_name(sid),
        "stage": info["stage"],
        "entry": entry or refl.entryPoint,
        "encoding": ename(refl.encoding),
        "firstEid": info["firstEid"],
        "pipeline": info["pipeline"],
        "compiler": ename(getattr(dbg, "compiler", "")),
        "sourceDebugInfo": bool(getattr(dbg, "sourceDebugInformation", False)),
        "debugStatus": getattr(dbg, "debugStatus", ""),
        "sourceEncoding": ename(getattr(dbg, "encoding", "")),
        "entrySourceName": getattr(dbg, "entrySourceName", ""),
        "editBaseFile": int(getattr(dbg, "editBaseFile", -1)),
        "files": [{"name": f.filename, "bytes": len(f.contents)} for f in dbg.files],
        "flags": [[f.name, f.value] for f in dbg.compileFlags.flags],
        "cbuffers": [{"name": cb.name, "bytes": int(cb.byteSize), "bind": int(getattr(cb, "fixedBindNumber", 0)),
                      "vars": flatten_constants(cb.variables)} for cb in refl.constantBlocks],
        "textures": [{"name": r.name, "type": ename(r.textureType), "bind": int(getattr(r, "fixedBindNumber", 0)),
                      "count": int(getattr(r, "bindArraySize", 1))} for r in refl.readOnlyResources],
        "rw": [{"name": r.name, "type": ename(r.textureType), "bind": int(getattr(r, "fixedBindNumber", 0))}
               for r in refl.readWriteResources],
        "samplers": [s.name for s in refl.samplers],
        "inputs": ["%s%s:%d" % (p.semanticName or p.varName, "" if not p.semanticIndex else p.semanticIndex, p.compCount)
                   for p in refl.inputSignature],
        "outputs": ["%s%s:%d" % (p.semanticName or p.varName, "" if not p.semanticIndex else p.semanticIndex, p.compCount)
                    for p in refl.outputSignature],
    }
    if info["stage"] == "cs":
        meta["threadGroup"] = [int(x) for x in refl.dispatchThreadsDimension]
    return meta


def task_shaders(ctx, task):
    seen = getattr(ctx, "_shaders_seen", None)
    if seen is None:
        raise RuntimeError("shaders task needs the state task earlier in the same job")
    sdir = os.path.join(ctx.out, "shaders")
    if not os.path.isdir(sdir):
        os.makedirs(sdir)
    targets = list(safe(lambda: ctx.c.GetDisassemblyTargets(True), []) or [])
    want = task.get("targets") or targets[:1]
    want = [t for t in want if t in targets] or targets[:1]
    metas = []
    t0 = time.time()
    for i, (key, info) in enumerate(sorted(seen.items(), key=lambda kv: kv[1]["firstEid"])):
        sid, entry = key
        meta = shader_meta(ctx, sid, entry, info)
        base = "%d" % sid if not entry or entry == "main" else "%d_%s" % (sid, re.sub(r"[^A-Za-z0-9_]", "_", entry))
        meta["key"] = base
        meta["disasm"] = {}
        for target in want:
            try:
                txt = ctx.c.DisassembleShader(_pipe_rid(ctx, info), info["refl"], target)
            except Exception as e:
                txt = "; disassembly failed: %s" % e
            fname = "%s.%s.txt" % (base, re.sub(r"[^A-Za-z0-9]+", "-", target).strip("-").lower())
            write_text(os.path.join(sdir, fname), txt)
            meta["disasm"][target] = fname
        if task.get("sources", True) and len(info["refl"].debugInfo.files) > 0:
            src_dir = os.path.join(sdir, base + ".src")
            names = []
            for f in info["refl"].debugInfo.files:
                fn = safe_rel(f.filename)
                write_text(os.path.join(src_dir, fn), f.contents)
                names.append(fn)
            meta["sourceDir"] = base + ".src"
            meta["sourceFiles"] = names
        metas.append(meta)
        if (i + 1) % 50 == 0:
            log("shaders %d/%d (%.1fs)" % (i + 1, len(seen), time.time() - t0))
    write_json(os.path.join(ctx.out, "shaders.json"), metas)
    log("shaders: %d unique" % len(metas))
    return {"shaders": len(metas)}


def _pipe_rid(ctx, info):
    # DisassembleShader wants the pipeline ResourceId object; recover it lazily.
    pid = info["pipeline"]
    if not pid:
        return ctx.rd.ResourceId()
    if not hasattr(ctx, "_ridmap"):
        ctx._ridmap = {}
        for r in ctx.c.GetResources():
            ctx._ridmap[rid(r.resourceId)] = r.resourceId
    return ctx._ridmap.get(pid, ctx.rd.ResourceId())


def safe_rel(name):
    name = name.replace("\\", "/")
    name = re.sub(r"^[A-Za-z]:/", "", name).lstrip("/")
    parts = [p for p in name.split("/") if p not in ("", ".", "..")]
    parts = [re.sub(r"[<>:\"|?*]", "_", p) for p in parts]
    return "/".join(parts) or "source.txt"


def find_action(ctx, eid):
    for x in ctx.actions():
        if int(x[0].eventId) == int(eid):
            return x[0]
    raise RuntimeError("EID %d is not an action in this capture" % eid)


def resource_by_id(ctx, i):
    for r in ctx.c.GetResources():
        if rid(r.resourceId) == int(i):
            return r.resourceId
    raise RuntimeError("resource %s not found" % i)


def save_texture(ctx, tex_rid, path, mip=0):
    rd = ctx.rd
    ts = rd.TextureSave()
    ts.resourceId = tex_rid
    ts.mip = mip
    ts.destType = rd.FileType.PNG
    ts.alpha = rd.AlphaMapping.Discard
    try:
        ts.slice.sliceIndex = 0
    except Exception:
        pass
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    res = ctx.c.SaveTexture(ts, path)
    ok = res.OK() if hasattr(res, "OK") else bool(res)
    if not ok:
        raise RuntimeError("SaveTexture failed: %s" % safe(lambda: res.Message(), ""))
    return path


def task_save_rt(ctx, task):
    eid = int(task["eid"])
    ctx.c.SetFrameEvent(eid, True)
    pipe = ctx.c.GetPipelineState()
    targets = []
    which = task.get("which", "color")
    a = find_action(ctx, eid)
    if which in ("color", "all"):
        rts = [d for d in (safe(pipe.GetOutputTargets, []) or []) if res_of(d)]
        if not rts:
            rts_ids = [rid(o) for o in a.outputs if rid(o)]
            targets += [("rt%d" % i, x) for i, x in enumerate(rts_ids)]
        else:
            targets += [("rt%d" % i, res_of(d)) for i, d in enumerate(rts)]
    if which in ("depth", "all"):
        dt = res_of(safe(pipe.GetDepthTarget))
        if dt:
            targets.append(("depth", dt))
    if task.get("resource"):
        targets = [("res", int(task["resource"]))]
    saved = []
    for label, tid in targets:
        p = os.path.join(task["dir"], "eid%d_%s_%d.png" % (eid, label, tid))
        try:
            save_texture(ctx, resource_by_id(ctx, tid), p)
            saved.append({"label": label, "id": tid, "path": p, "texture": tex_info(ctx, tid)})
        except Exception as e:
            saved.append({"label": label, "id": tid, "error": str(e)})
    return {"images": saved}


def shader_variable_json(v, depth=0):
    members = list(getattr(v, "members", []) or [])
    if members and depth < 4:
        return {"name": v.name, "members": [shader_variable_json(m, depth + 1) for m in members[:64]]}
    n = int(v.rows) * int(v.columns)
    t = ename(v.type)
    try:
        if t.startswith("Float") or t == "Half":
            vals = list(v.value.f32v)[:n]
            vals = [round(x, 6) for x in vals]
        elif t.startswith("UInt") or t == "Bool":
            vals = list(v.value.u32v)[:n]
        elif t.startswith("SInt"):
            vals = list(v.value.s32v)[:n]
        elif t == "Double":
            vals = list(v.value.f64v)[:n]
        else:
            vals = list(v.value.u32v)[:n]
    except Exception:
        vals = []
    return {"name": v.name, "type": t, "rows": int(v.rows), "cols": int(v.columns), "value": vals}


def task_draw(ctx, task):
    """Deep detail for one event: state, bound textures, cbuffer contents."""
    rd, c = ctx.rd, ctx.c
    eid = int(task["eid"])
    a = find_action(ctx, eid)
    if action_kind(rd, a.flags) not in ("draw", "dispatch"):
        raise RuntimeError("EID %d (%s) is a %s, not a draw/dispatch" % (eid, ctx.action_name(a), action_kind(rd, a.flags)))
    seen = {}
    st = collect_state(ctx, a, seen)
    pipe = c.GetPipelineState()
    detail = {"state": st, "name": ctx.action_name(a), "kind": action_kind(rd, a.flags),
              "indices": int(a.numIndices), "instances": int(a.numInstances)}
    stages = {}
    for (sid, entry), info in seen.items():
        short = info["stage"]
        stage = stage_enum(rd, short)
        refl = info["refl"]
        sd = {"id": sid, "entry": entry, "encoding": ename(refl.encoding), "cbuffers": []}
        for idx, cb in enumerate(refl.constantBlocks):
            entry_cb = {"name": cb.name, "bytes": int(cb.byteSize)}
            try:
                bound = None
                if hasattr(pipe, "GetConstantBlock"):
                    bound = pipe.GetConstantBlock(stage, idx, 0)
                buf = res_of(bound)
                off = int(getattr(getattr(bound, "descriptor", bound), "byteOffset", 0))
                size = int(getattr(getattr(bound, "descriptor", bound), "byteSize", 0))
                bufobj = resource_by_id(ctx, buf) if buf else rd.ResourceId()
                vars_ = c.GetCBufferVariableContents(_pipe_rid(ctx, info), refl.resourceId, stage, entry or refl.entryPoint,
                                                     idx, bufobj, off, size)
                entry_cb["vars"] = [shader_variable_json(v) for v in list(vars_)[:256]]
                entry_cb["buffer"] = buf
            except Exception as e:
                entry_cb["error"] = str(e)
            sd["cbuffers"].append(entry_cb)
        sd["textures"] = []
        for u in (safe(lambda: pipe.GetReadOnlyResources(stage, True), []) or []):
            r = res_of(u)
            if not r:
                continue
            idx = safe(lambda: int(u.access.index), -1)
            nm = refl.readOnlyResources[idx].name if 0 <= idx < len(refl.readOnlyResources) else ""
            sd["textures"].append({"slot": nm, "tex": tex_info(ctx, r)})
        stages[short] = sd
    detail["stages"] = stages
    rts = []
    for r in st.get("rts", []):
        rts.append(tex_info(ctx, r))
    detail["rts"] = rts
    if st.get("depthTarget"):
        detail["depthTarget"] = tex_info(ctx, st["depthTarget"])
    write_json(os.path.join(ctx.out, task.get("file", "draw-%d.json" % eid)), detail)
    return {"file": task.get("file", "draw-%d.json" % eid)}


# ------------------------------------------------------------ shader experiments

INCLUDE_RE = re.compile(r'^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"].*$', re.M)
PRAGMA_ONCE_RE = re.compile(r"^[ \t]*#[ \t]*pragma[ \t]+once", re.M)


def expand_includes(source, files, stack=None, included=None):
    """Same idea as qrenderdoc's ProcessIncludeDirectives: inline #includes from the captured file set."""
    if stack is None:
        stack = []
    if included is None:
        included = set()
    source = PRAGMA_ONCE_RE.sub("// #pragma once", source)

    def lookup(fname):
        if fname in files:
            return fname
        base = fname.replace("\\", "/").split("/")[-1].lower()
        for k in files:
            if k.replace("\\", "/").split("/")[-1].lower() == base:
                return k
        return None

    def repl(m):
        fname = m.group(1)
        k = lookup(fname)
        if k is None:
            return "// can't find file %s" % fname
        if k in stack:
            return "// not recursively including %s" % fname
        if k in included and PRAGMA_ONCE_RE.search(files[k]):
            return "// not re-including %s (pragma once)" % fname
        included.add(k)
        return "\n" + expand_includes(files[k], files, stack + [k], included) + "\n"

    return INCLUDE_RE.sub(repl, source)


def load_variant_source(spec, refl):
    """spec: {dir: path} (dumped/edited source tree with meta main file) | {file: path} | {original: true}."""
    if spec.get("original"):
        files = dict((f.filename, f.contents) for f in refl.debugInfo.files)
        if not files:
            raise RuntimeError("shader has no embedded source (compile it with debug info, see references/unity-shaders.md)")
        base = int(getattr(refl.debugInfo, "editBaseFile", -1))
        if base < 0:
            base = max(0, int(getattr(getattr(refl.debugInfo, "entryLocation", None), "fileIndex", 0) or 0))
        main = refl.debugInfo.files[base].filename
        return expand_includes(files[main], files)
    if spec.get("file"):
        with open(spec["file"], "r", encoding="utf-8") as f:
            text = f.read()
        files = {}
        root = os.path.dirname(spec["file"])
        for dp, dn, fn in os.walk(root):
            for n in fn:
                p = os.path.join(dp, n)
                if os.path.abspath(p) == os.path.abspath(spec["file"]):
                    continue
                rel = os.path.relpath(p, root).replace("\\", "/")
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        files[rel] = f.read()
                except Exception:
                    pass
        return expand_includes(text, files)
    raise RuntimeError("variant needs 'file' or 'original'")


def edit_flags(rd, refl, spec):
    flags = rd.ShaderCompileFlags()
    out = []
    for f in refl.debugInfo.compileFlags.flags:
        val = f.value
        if f.name == "@cmdline":
            toks = val.split()
            for t in spec.get("remove", []):
                toks = [x for x in toks if x.lower() != t.lower()]
            for t in spec.get("add", []):
                if t not in toks:
                    toks.append(t)
            if spec.get("cmdline") is not None:
                toks = spec["cmdline"].split()
            val = " ".join(toks)
        nf = rd.ShaderCompileFlag()
        nf.name = f.name
        nf.value = val
        out.append(nf)
    if not any(f.name == "@cmdline" for f in out) and (spec.get("add") or spec.get("cmdline")):
        nf = rd.ShaderCompileFlag()
        nf.name = "@cmdline"
        nf.value = spec.get("cmdline") or " ".join(spec.get("add", []))
        out.append(nf)
    flags.flags = out
    return flags, [[f.name, f.value] for f in out]


def encoding_for(rd, ctx, refl, name):
    encs = list(ctx.c.GetTargetShaderEncodings())
    if name:
        e = getattr(rd.ShaderEncoding, name)
        if e not in encs:
            raise RuntimeError("encoding %s not accepted by this API (accepted: %s)" % (name, ", ".join(ename(x) for x in encs)))
        return e
    src = getattr(refl.debugInfo, "encoding", None)
    if src is not None and src in encs:
        return src
    for pref in ("HLSL", "GLSL", "Slang"):
        e = getattr(rd.ShaderEncoding, pref, None)
        if e is not None and e in encs:
            return e
    return encs[0]


def measure(ctx, descs, eids, repeat):
    runs = [fetch(ctx, descs, 64) for _ in range(repeat)]
    res = {}
    for d in descs:
        n = d["name"]
        per = {}
        total = []
        for run in runs:
            s = 0.0
            for eid, vals in run.items():
                v = vals.get(n)
                if v is None:
                    continue
                if d["unit"] == "Seconds":
                    v = v * 1000.0
                if eid in eids:
                    per.setdefault(eid, []).append(v)
                s += v
            total.append(s)
        res[n] = {"perEvent": dict((str(k), {"median": median(v), "min": min(v), "max": max(v)}) for k, v in per.items()),
                  "targetSum": median([sum(run.get(e, {}).get(n, 0.0) * (1000.0 if d["unit"] == "Seconds" else 1.0)
                                           for e in eids) for run in runs]),
                  "frameTotal": median(total) if d["unit"] in ("Seconds", "Absolute", "Bytes") else None,
                  "unit": "ms" if d["unit"] == "Seconds" else d["unit"]}
    return res


def texel_layout(ctx, tid):
    """(struct char, scale, components) for regular formats, or None for packed/compressed ones."""
    if not hasattr(ctx, "_texobj"):
        ctx._texobj = dict((rid(t.resourceId), t) for t in ctx.c.GetTextures())
    t = ctx._texobj.get(tid)
    if t is None:
        return None, None
    f = t.format
    if ename(getattr(f, "type", "Regular")) != "Regular":
        return None, t
    w, n, ct = int(f.compByteWidth), int(f.compCount), ename(f.compType)
    table = {("Float", 2): ("e", 1.0), ("Float", 4): ("f", 1.0), ("UNorm", 1): ("B", 255.0), ("UNormSRGB", 1): ("B", 255.0),
             ("UNorm", 2): ("H", 65535.0), ("SNorm", 1): ("b", 127.0), ("SNorm", 2): ("h", 32767.0),
             ("UInt", 1): ("B", 1.0), ("UInt", 2): ("H", 1.0), ("UInt", 4): ("I", 1.0), ("SInt", 4): ("i", 1.0)}
    ch = table.get((ct, w))
    if ch is None:
        return None, t
    return (ch[0], ch[1], n), t


def decode_texels(ctx, tid, data, limit=4000000):
    import struct
    lay, t = texel_layout(ctx, tid)
    if lay is None:
        return None
    ch, scale, n = lay
    size = struct.calcsize(ch)
    count = len(data) // size
    vals = struct.unpack("<%d%s" % (count, ch), data[:count * size])
    step = 1
    texels = count // n
    if texels * n > limit:
        step = int(texels * n // limit) + 1
    return {"vals": vals, "n": n, "scale": scale, "step": step, "texels": texels}


def compare_texels(ctx, tid, ref, data):
    a, b = ref["data"], data
    if len(a) != len(b):
        return {"target": tid, "changedPct": None, "note": "size differs"}
    ra = ref.get("vals")
    if ra is None:
        # packed format: byte-level comparison only
        lay, t = texel_layout(ctx, tid)
        texels = max(1, int(getattr(t, "width", 1)) * int(getattr(t, "height", 1))) if t is not None else 1
        step = max(1, len(a) // texels)
        changed = sum(1 for i in range(0, len(a), step) if a[i:i + step] != b[i:i + step])
        return {"target": tid, "changedPct": round(100.0 * changed / texels, 3), "note": "packed format: error size not computed"}
    rb = decode_texels(ctx, tid, data)
    n, scale, step = ra["n"], ra["scale"], ra["step"]
    va, vb = ra["vals"], rb["vals"]
    changed = 0
    checked = 0
    maxabs = 0.0
    sumabs = 0.0
    sumsq = 0.0
    peak = 0.0
    for t in range(0, ra["texels"], step):
        diff = False
        o = t * n
        for k in range(n):
            x = va[o + k] / scale
            y = vb[o + k] / scale
            if x != x or y != y:
                continue
            d = abs(x - y)
            if d > 0:
                diff = True
                if d > maxabs:
                    maxabs = d
                sumabs += d
                sumsq += d * d
            if abs(x) > peak:
                peak = abs(x)
        checked += 1
        if diff:
            changed += 1
    import math
    nvals = max(1, checked * n)
    mse = sumsq / nvals
    peak = max(peak, 1.0)
    res = {"target": tid, "changedPct": round(100.0 * changed / max(1, checked), 3),
           "maxAbs": round(maxabs, 6), "meanAbs": round(sumabs / nvals, 7),
           "psnr": round(10 * math.log10(peak * peak / mse), 1) if mse > 0 else None,
           "peak": round(peak, 4)}
    if step > 1:
        res["sampled"] = "every %d texels" % step
    return res


def task_experiment(ctx, task):
    rd, c = ctx.rd, ctx.c
    eid = int(task["eid"])
    short = task.get("stage", "ps")
    stage = stage_enum(rd, short)
    c.SetFrameEvent(eid, True)
    pipe = c.GetPipelineState()
    orig = pipe.GetShader(stage)
    if rid(orig) == 0:
        raise RuntimeError("no %s shader bound at EID %d" % (short, eid))
    refl = pipe.GetShaderReflection(stage)
    entry_point = pipe.GetShaderEntryPoint(stage) or refl.entryPoint
    # every work action using the same shader is affected by the replacement
    users = [int(u) for u in (task.get("users") or [])]
    for x in ([] if users else ctx.work_actions()):
        a = x[0]
        if task.get("scanUsers", True):
            c.SetFrameEvent(a.eventId, False)
            if rid(c.GetPipelineState().GetShader(stage)) == rid(orig):
                users.append(int(a.eventId))
    if not users:
        users = [eid]
    c.SetFrameEvent(eid, True)
    names = task.get("counters") or ["GPU Duration"]
    descs, missing = resolve_counters(ctx, names)
    if not descs:
        raise RuntimeError("none of the requested counters exist: %s" % ", ".join(names))
    repeat = int(task.get("repeat", 5))
    img_dir = task.get("imageDir")
    results = {"eid": eid, "stage": short, "shader": rid(orig), "entry": entry_point,
               "encoding": ename(refl.encoding), "sourceEncoding": ename(getattr(refl.debugInfo, "encoding", "")),
               "originalFlags": [[f.name, f.value] for f in refl.debugInfo.compileFlags.flags],
               "usersOfShader": users, "missingCounters": missing, "repeat": repeat, "variants": []}

    def snap(label):
        if not img_dir:
            return None
        try:
            c.SetFrameEvent(eid, True)
            p2 = c.GetPipelineState()
            rts = [d for d in (safe(p2.GetOutputTargets, []) or []) if res_of(d)]
            if not rts:
                return None
            return save_texture(ctx, resource_by_id(ctx, res_of(rts[0])), os.path.join(img_dir, "%s_eid%d.png" % (label, eid)))
        except Exception as e:
            log("snapshot failed: %s" % e)
            return None

    ref = {}

    def pixels(label):
        """Render target 0 after the event, compared with the captured output: changed texels and error size."""
        try:
            c.SetFrameEvent(eid, True)
            p2 = c.GetPipelineState()
            rts = [d for d in (safe(p2.GetOutputTargets, []) or []) if res_of(d)]
            if not rts:
                return None
            tid = res_of(rts[0])
            data = bytes(c.GetTextureData(resource_by_id(ctx, tid), rd.Subresource(0, 0, 0)))
            if "data" not in ref:
                ref["data"] = data
                ref["vals"] = decode_texels(ctx, tid, data)
                return {"target": tid, "changedPct": 0.0, "maxAbs": 0.0, "meanAbs": 0.0}
            return compare_texels(ctx, tid, ref, data)
        except Exception as e:
            return {"error": str(e)}

    log("experiment: baseline (captured binary), %d run(s)" % repeat)
    base = {"label": "captured", "metrics": measure(ctx, descs, users, repeat), "image": snap("captured"),
            "output": pixels("captured")}
    results["variants"].append(base)
    for spec in task.get("variants", []):
        label = spec.get("label", "variant")
        v = {"label": label}
        built = None
        try:
            src = load_variant_source(spec, refl)
            flags, flag_list_ = edit_flags(rd, refl, spec.get("flags", {}))
            enc = encoding_for(rd, ctx, refl, spec.get("encoding"))
            entry = spec.get("entry") or getattr(refl.debugInfo, "entrySourceName", "") or entry_point
            v.update({"encoding": ename(enc), "entry": entry, "flags": flag_list_})
            if spec.get("saveExpanded"):
                write_text(spec["saveExpanded"], src)
            log("experiment[%s]: compiling (%s, entry %s)" % (label, ename(enc), entry))
            built, errors = c.BuildTargetShader(entry, enc, src.encode("utf-8"), flags, stage)
            v["compilerOutput"] = (errors or "")[:6000]
            if rid(built) == 0:
                v["error"] = "compile failed"
                results["variants"].append(v)
                continue
            c.ReplaceResource(orig, built)
            log("experiment[%s]: measuring %d run(s)" % (label, repeat))
            v["metrics"] = measure(ctx, descs, users, repeat)
            v["image"] = snap(label)
            v["output"] = pixels(label)
        except Exception as e:
            v["error"] = str(e)
        finally:
            safe(lambda: c.RemoveReplacement(orig))
            if built is not None and rid(built):
                safe(lambda: c.FreeTargetResource(built))
        results["variants"].append(v)
    write_json(os.path.join(ctx.out, task.get("file", "experiment.json")), results)
    return {"file": task.get("file", "experiment.json"), "variants": len(results["variants"])}


def task_dump_source(ctx, task):
    """Write a shader's embedded source tree (for editing) plus a meta file."""
    rd, c = ctx.rd, ctx.c
    eid = int(task["eid"])
    short = task.get("stage", "ps")
    stage = stage_enum(rd, short)
    c.SetFrameEvent(eid, True)
    pipe = c.GetPipelineState()
    refl = pipe.GetShaderReflection(stage)
    if refl is None:
        raise RuntimeError("no %s shader at EID %d" % (short, eid))
    dbg = refl.debugInfo
    d = task["dir"]
    files = []
    for f in dbg.files:
        rel = safe_rel(f.filename)
        write_text(os.path.join(d, rel), f.contents)
        files.append(rel)
    base = int(getattr(dbg, "editBaseFile", -1))
    if base < 0:
        base = max(0, int(getattr(getattr(dbg, "entryLocation", None), "fileIndex", 0) or 0))
    meta = {"eid": eid, "stage": short, "shader": rid(pipe.GetShader(stage)),
            "entry": getattr(dbg, "entrySourceName", "") or refl.entryPoint,
            "encoding": ename(refl.encoding), "sourceEncoding": ename(getattr(dbg, "encoding", "")),
            "flags": [[f.name, f.value] for f in dbg.compileFlags.flags],
            "files": files, "main": files[base] if files else None}
    if not files:
        pipeline = rid(safe(pipe.GetGraphicsPipelineObject if short != "cs" else pipe.GetComputePipelineObject, 0))
        targets = list(safe(lambda: c.GetDisassemblyTargets(True), []) or [])
        txt = c.DisassembleShader(_pipe_rid(ctx, {"pipeline": pipeline}), refl, targets[0] if targets else "")
        write_text(os.path.join(d, "disassembly.txt"), txt)
        meta["note"] = "no embedded source; only disassembly written"
    write_json(os.path.join(d, "meta.json"), meta)
    return meta


def task_usage(ctx, task):
    """Which events read/write a resource (texture or buffer)."""
    r = resource_by_id(ctx, int(task["resource"]))
    uses = ctx.c.GetUsage(r)
    rows = [{"eid": int(u.eventId), "usage": ename(u.usage)} for u in uses]
    return {"resource": int(task["resource"]), "usage": rows}


TASKS = {
    "info": task_info,
    "actions": task_actions,
    "counters": task_counters,
    "state": task_state,
    "shaders": task_shaders,
    "save_rt": task_save_rt,
    "draw": task_draw,
    "experiment": task_experiment,
    "dump_source": task_dump_source,
    "usage": task_usage,
}


def run_tasks(ctx, tasks):
    entries = []
    for task in tasks:
        t = time.time()
        name = task["type"]
        log("task %s" % name)
        entry = {"type": name}
        try:
            entry["result"] = TASKS[name](ctx, task)
            entry["ok"] = True
        except Exception as e:
            entry["ok"] = False
            entry["error"] = "%s: %s" % (type(e).__name__, e)
            entry["traceback"] = traceback.format_exc()[-4000:]
            log("task %s FAILED: %s" % (name, e))
            if task.get("required", False):
                entries.append(entry)
                raise
        entry["seconds"] = round(time.time() - t, 2)
        entries.append(entry)
    return entries


def serve(ctx, job):
    """Session mode: keep the capture loaded and run jobs dropped into the inbox until idle/stop."""
    global PROGRESS
    sdir = job["serve"]["dir"]
    inbox = os.path.join(sdir, "inbox")
    if not os.path.isdir(inbox):
        os.makedirs(inbox)
    idle = float(job["serve"].get("idle", 900))
    alive = os.path.join(sdir, "alive.json")
    stop = os.path.join(sdir, "stop")
    last = time.time()
    served = 0
    main_progress = PROGRESS
    log("session ready (idle timeout %ds)" % idle)
    while True:
        write_json(alive, {"pid": os.getpid(), "t": time.time(), "capture": job["capture"], "served": served, "idle": idle})
        if os.path.exists(stop) or time.time() - last > idle:
            break
        names = sorted(n for n in os.listdir(inbox) if n.endswith(".json"))
        if not names:
            time.sleep(0.25)
            continue
        path = os.path.join(inbox, names[0])
        try:
            with open(path, "r", encoding="utf-8") as f:
                sub = json.load(f)
        except Exception:
            time.sleep(0.1)
            continue
        os.remove(path)
        write_json(alive, {"pid": os.getpid(), "t": time.time(), "capture": job["capture"], "served": served, "idle": idle, "busy": True})
        sub_result = {"ok": False, "tasks": [], "started": time.time(), "host": "session"}
        try:
            if not os.path.isdir(sub["out"]):
                os.makedirs(sub["out"])
            PROGRESS = open(sub["progress"], "a", encoding="utf-8")
            log("session job %s" % ", ".join(t["type"] for t in sub["tasks"]))
            ctx.out = sub["out"]
            ctx._shaders_seen = None
            sub_result["tasks"] = run_tasks(ctx, sub["tasks"])
            sub_result["ok"] = all(x.get("ok") for x in sub_result["tasks"])
        except Exception as e:
            sub_result["error"] = "%s: %s" % (type(e).__name__, e)
            sub_result["traceback"] = traceback.format_exc()[-4000:]
        finally:
            sub_result["seconds"] = round(time.time() - sub_result["started"], 2)
            sub_result["renderdocVersion"] = safe(ctx.rd.GetVersionString, "")
            if PROGRESS is not None and PROGRESS is not main_progress:
                log("done")
                PROGRESS.close()
            PROGRESS = main_progress
            write_json(sub["result"], sub_result)
            served += 1
            last = time.time()
    for f in (alive, stop):
        if os.path.exists(f):
            os.remove(f)
    log("session ended after %d job(s)" % served)
    return {"served": served}


# ---------------------------------------------------------------- main

def main():
    global JOB, PROGRESS
    argv = getattr(sys, "argv", None) or []  # embedded interpreters may not set argv
    job_path = os.environ.get("RDGPU_JOB") or (argv[1] if len(argv) > 1 and argv[1].endswith(".json") else None)
    if not job_path:
        raise SystemExit(2)
    with open(job_path, "r", encoding="utf-8") as f:
        JOB = json.load(f)
    out = JOB["out"]
    if not os.path.isdir(out):
        os.makedirs(out)
    PROGRESS = open(JOB.get("progress", os.path.join(out, "progress.log")), "a", encoding="utf-8")
    log("rdjob started (python %s)" % sys.version.split()[0])
    result = {"ok": False, "tasks": [], "started": time.time()}
    result_path = JOB.get("result", os.path.join(out, "result.json"))
    cap = controller = None
    in_ui = "pyrenderdoc" in globals() or "qrenderdoc" in sys.modules
    rd = None
    try:
        rd = import_rd()
        result["renderdocVersion"] = safe(rd.GetVersionString, "")
        result["host"] = "qrenderdoc" if in_ui else "python"
        if JOB.get("tasks") == ["version"]:
            result["ok"] = True
            return
        cap, controller = open_capture(rd, JOB["capture"], in_ui)
        ctx = Ctx(rd, cap, controller, out)
        if JOB.get("serve"):
            result["tasks"].append({"type": "session", "ok": True, "result": serve(ctx, JOB)})
            result["ok"] = True
        else:
            result["tasks"] = run_tasks(ctx, JOB["tasks"])
            result["ok"] = all(x.get("ok") for x in result["tasks"])
    except SystemExit:
        raise
    except Exception as e:
        result["error"] = "%s: %s" % (type(e).__name__, e)
        result["traceback"] = traceback.format_exc()[-4000:]
        log("FAILED: %s" % e)
    finally:
        result["seconds"] = round(time.time() - result["started"], 2)
        if controller is not None:
            safe(controller.Shutdown)
        if cap is not None:
            safe(cap.Shutdown)
        if rd is not None and not in_ui:
            safe(rd.ShutdownReplay)
        try:
            write_json(result_path, result)
        finally:
            log("done")
            if PROGRESS is not None:
                PROGRESS.close()


if not os.environ.get("RDGPU_IMPORT_ONLY"):
    try:
        main()
    finally:
        # qrenderdoc treats SystemExit as "script asked to quit" and skips opening the UI.
        raise SystemExit(0)
