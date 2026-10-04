"""Synthetic Unity-like OpenGL frame used to produce RenderDoc test captures.

Runs on any GL 4.5 core driver (Mesa llvmpipe under Xvfb is enough). It mimics a
URP frame: shadow map, opaque pass with a light loop, skybox, overdraw-heavy
particles, a bloom chain, uber post and UI. Two variants exist so before/after
comparisons have a known ground truth.

  LD_PRELOAD=<renderdoc>/lib/librenderdoc.so python3 scene.py --variant a --out a.rdc

Variant differences (ground truth for evals):
  b: Lit shader loops over 24 additional lights instead of 4 (same geometry),
     particle count 160 -> 420 (more overdraw), bloom blur taps 9 -> 25.
"""

import argparse
import ctypes
import math
import os
import sys

import glfw
import numpy as np
import OpenGL.platform.glx as _glx
from OpenGL.platform import baseplatform, ctypesloader

# PyOpenGL prefers GLVND's libOpenGL.so, which RenderDoc does not hook; force libGL.so.
_glx.GLXPlatform.GL = baseplatform.lazy_property(
    lambda self: ctypesloader.loadLibrary(ctypes.cdll, "GL", mode=ctypes.RTLD_GLOBAL))
from OpenGL import GL as gl  # noqa: E402

W, H = 1280, 720
LABELS = True


# ---------------------------------------------------------------- shaders

COMMON = "#version 430 core\n"

LIT_VS = COMMON + """
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(std140, binding=0) uniform UnityPerDraw { mat4 unity_ObjectToWorld; };
layout(std140, binding=1) uniform UnityPerFrame { mat4 unity_MatrixVP; mat4 _MainLightWorldToShadow; vec4 _MainLightPosition; vec4 _TimeParameters; };
out vec3 vWorldPos; out vec3 vNormal; out vec2 vUV; out vec4 vShadowCoord;
void main(){
  vec4 wp = unity_ObjectToWorld * vec4(aPos,1);
  vWorldPos = wp.xyz; vNormal = mat3(unity_ObjectToWorld)*aNormal; vUV = aUV;
  vShadowCoord = _MainLightWorldToShadow * wp;
  gl_Position = unity_MatrixVP * wp;
}
"""

LIT_FS = COMMON + """
in vec3 vWorldPos; in vec3 vNormal; in vec2 vUV; in vec4 vShadowCoord;
layout(std140, binding=1) uniform UnityPerFrame { mat4 unity_MatrixVP; mat4 _MainLightWorldToShadow; vec4 _MainLightPosition; vec4 _TimeParameters; };
layout(std140, binding=2) uniform UnityPerMaterial { vec4 _BaseColor; vec4 _BaseMap_ST; float _Smoothness; float _Metallic; float _BumpScale; float _OcclusionStrength; };
layout(std140, binding=3) uniform AdditionalLights { vec4 _AdditionalLightsCount; vec4 _AdditionalLightsPosition[32]; vec4 _AdditionalLightsColor[32]; };
layout(binding=0) uniform sampler2D _BaseMap;
layout(binding=1) uniform sampler2D _BumpMap;
layout(binding=2) uniform sampler2D _MainLightShadowmapTexture;
out vec4 outColor;
float SampleShadow(vec4 sc){
  vec3 p = sc.xyz / sc.w * 0.5 + 0.5; float s = 0.0;
  for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++){
    float d = texture(_MainLightShadowmapTexture, p.xy + vec2(i,j)/2048.0).r;
    s += (p.z - 0.002 > d) ? 0.0 : 1.0; }
  return s/9.0;
}
void main(){
  vec2 uv = vUV*_BaseMap_ST.xy + _BaseMap_ST.zw;
  vec3 albedo = texture(_BaseMap, uv).rgb * _BaseColor.rgb;
  vec3 n = normalize(vNormal + (texture(_BumpMap, uv).xyz*2.0-1.0)*_BumpScale*0.2);
  vec3 L = normalize(_MainLightPosition.xyz);
  vec3 col = albedo * max(dot(n,L),0.0) * SampleShadow(vShadowCoord);
  int count = int(_AdditionalLightsCount.x);
  for(int i=0;i<count;i++){
    vec3 d = _AdditionalLightsPosition[i].xyz - vWorldPos;
    float att = 1.0/(1.0+dot(d,d));
    vec3 h = normalize(normalize(d) + vec3(0,0,1));
    float spec = pow(max(dot(n,h),0.0), 8.0 + _Smoothness*120.0);
    col += (albedo*max(dot(n,normalize(d)),0.0) + spec*_Metallic) * _AdditionalLightsColor[i].rgb * att;
  }
  outColor = vec4(col + albedo*0.05*_OcclusionStrength, 1.0);
}
"""

SHADOW_VS = COMMON + """
layout(location=0) in vec3 aPos;
layout(std140, binding=0) uniform UnityPerDraw { mat4 unity_ObjectToWorld; };
layout(std140, binding=1) uniform UnityPerFrame { mat4 unity_MatrixVP; mat4 _MainLightWorldToShadow; vec4 _MainLightPosition; vec4 _TimeParameters; };
void main(){ gl_Position = _MainLightWorldToShadow * unity_ObjectToWorld * vec4(aPos,1); }
"""
SHADOW_FS = COMMON + "void main(){}\n"

FULLSCREEN_VS = COMMON + """
out vec2 vUV;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.0-1.0,0,1); }
"""

SKY_FS = COMMON + """
in vec2 vUV; out vec4 outColor;
layout(std140, binding=4) uniform SkyboxParams { vec4 _SkyTint; vec4 _GroundColor; float _Exposure; float _AtmosphereThickness; };
void main(){ float t = vUV.y; outColor = vec4(mix(_GroundColor.rgb, _SkyTint.rgb, t) * _Exposure, 1); }
"""

PARTICLE_VS = COMMON + """
layout(location=0) in vec3 aPos;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aInstance;
out vec2 vUV; out float vAlpha;
void main(){ vUV = aUV; vAlpha = aInstance.w; gl_Position = vec4(aPos.xy*aInstance.z + aInstance.xy, 0.5, 1); }
"""
PARTICLE_FS = COMMON + """
in vec2 vUV; in float vAlpha; out vec4 outColor;
layout(binding=0) uniform sampler2D _MainTex;
layout(std140, binding=5) uniform ParticlesUnlit { vec4 _TintColor; float _SoftParticlesNearFadeDistance; float _SoftParticlesFarFadeDistance; float _CameraFadingEnabled; float _DistortionStrength; };
void main(){
  vec4 t = texture(_MainTex, vUV) * texture(_MainTex, vUV*1.7+0.1);
  float r = length(vUV-0.5)*2.0; float a = clamp(1.0-r,0.0,1.0)*vAlpha*_TintColor.a;
  outColor = vec4(t.rgb*_TintColor.rgb, a);
}
"""

BLOOM_FS = COMMON + """
in vec2 vUV; out vec4 outColor;
layout(binding=0) uniform sampler2D _SourceTex;
layout(std140, binding=6) uniform BloomParams { vec4 _Params; vec4 _SourceTex_TexelSize; int _BlurTaps; float _Threshold; float _Scatter; float _Intensity; };
void main(){
  vec3 c = vec3(0); float wsum = 0.0; int half_ = _BlurTaps/2;
  for(int i=-half_;i<=half_;i++) for(int j=-half_;j<=half_;j++){
    float w = exp(-float(i*i+j*j)/(2.0*float(half_*half_+1)));
    c += max(texture(_SourceTex, vUV + vec2(i,j)*_SourceTex_TexelSize.xy).rgb - _Threshold, 0.0)*w; wsum += w; }
  outColor = vec4(c/wsum*_Intensity, 1);
}
"""

UBER_FS = COMMON + """
in vec2 vUV; out vec4 outColor;
layout(binding=0) uniform sampler2D _SourceTex;
layout(binding=1) uniform sampler2D _Bloom_Texture;
layout(binding=2) uniform sampler3D _InternalLut;
layout(std140, binding=7) uniform UberPostParams { vec4 _Lut_Params; vec4 _Vignette_Params; float _Bloom_Intensity; float _Grain_Intensity; float _Chroma_Amount; float _PostExposure; };
void main(){
  vec2 d = (vUV-0.5)*_Chroma_Amount;
  vec3 c = vec3(texture(_SourceTex, vUV-d).r, texture(_SourceTex, vUV).g, texture(_SourceTex, vUV+d).b);
  c += texture(_Bloom_Texture, vUV).rgb * _Bloom_Intensity;
  c = texture(_InternalLut, clamp(c*_PostExposure,0.0,1.0)).rgb;
  float v = 1.0 - dot(vUV-0.5, vUV-0.5)*_Vignette_Params.x;
  outColor = vec4(c*v, 1);
}
"""

UI_VS = COMMON + """
layout(location=0) in vec3 aPos; layout(location=2) in vec2 aUV; layout(location=3) in vec4 aInstance;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = vec4(aPos.xy*aInstance.zw + aInstance.xy, 0, 1); }
"""
UI_FS = COMMON + """
in vec2 vUV; out vec4 outColor;
layout(binding=0) uniform sampler2D _MainTex;
layout(std140, binding=8) uniform UIDefault { vec4 _Color; vec4 _ClipRect; float _UIMaskSoftnessX; float _UIMaskSoftnessY; };
void main(){ outColor = texture(_MainTex, vUV) * _Color; }
"""


def compile_program(label, vs, fs):
    prog = gl.glCreateProgram()
    for src, kind in ((vs, gl.GL_VERTEX_SHADER), (fs, gl.GL_FRAGMENT_SHADER)):
        sh = gl.glCreateShader(kind)
        gl.glShaderSource(sh, src)
        gl.glCompileShader(sh)
        if not gl.glGetShaderiv(sh, gl.GL_COMPILE_STATUS):
            raise RuntimeError(label + ": " + gl.glGetShaderInfoLog(sh).decode())
        gl.glAttachShader(prog, sh)
    gl.glLinkProgram(prog)
    if not gl.glGetProgramiv(prog, gl.GL_LINK_STATUS):
        raise RuntimeError(label + ": " + gl.glGetProgramInfoLog(prog).decode())
    if LABELS:
        gl.glObjectLabel(gl.GL_PROGRAM, prog, len(label), label)
    return prog


# ---------------------------------------------------------------- geometry

def sphere(rings, segments):
    verts = []
    for r in range(rings + 1):
        v = r / rings
        phi = v * math.pi
        for s in range(segments + 1):
            u = s / segments
            th = u * 2 * math.pi
            x, y, z = math.sin(phi) * math.cos(th), math.cos(phi), math.sin(phi) * math.sin(th)
            verts += [x, y, z, x, y, z, u, v]
    idx = []
    for r in range(rings):
        for s in range(segments):
            a = r * (segments + 1) + s
            b = a + segments + 1
            idx += [a, b, a + 1, b, b + 1, a + 1]
    return np.array(verts, np.float32), np.array(idx, np.uint32)


def cube():
    v = []
    faces = [((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, 1, 0), (0, 0, -1)),
             ((0, 1, 0), (0, 0, 1), (1, 0, 0)), ((0, -1, 0), (0, 0, -1), (1, 0, 0)),
             ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (-1, 0, 0), (0, 1, 0))]
    idx = []
    for n, a, b in faces:
        base = len(v) // 8
        for du, dv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            p = [n[i] + a[i] * du + b[i] * dv for i in range(3)]
            v += [c * 0.5 for c in p] + list(n) + [(du + 1) / 2, (dv + 1) / 2]
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return np.array(v, np.float32), np.array(idx, np.uint32)


def quad():
    v = np.array([-1, -1, 0, 0, 0, 1, 0, 0, 1, -1, 0, 0, 0, 1, 1, 0,
                  1, 1, 0, 0, 0, 1, 1, 1, -1, 1, 0, 0, 0, 1, 0, 1], np.float32)
    return v, np.array([0, 1, 2, 0, 2, 3], np.uint32)


class Mesh:
    def __init__(self, label, data, instances=None):
        verts, idx = data
        self.count = len(idx)
        self.vao = gl.glGenVertexArrays(1)
        gl.glBindVertexArray(self.vao)
        vbo, ibo = gl.glGenBuffers(2)
        gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo)
        gl.glBufferData(gl.GL_ARRAY_BUFFER, verts.nbytes, verts, gl.GL_STATIC_DRAW)
        gl.glObjectLabel(gl.GL_BUFFER, vbo, len(label + " VB"), label + " VB")
        for loc, size, off in ((0, 3, 0), (1, 3, 12), (2, 2, 24)):
            gl.glEnableVertexAttribArray(loc)
            gl.glVertexAttribPointer(loc, size, gl.GL_FLOAT, False, 32, ctypes.c_void_p(off))
        gl.glBindBuffer(gl.GL_ELEMENT_ARRAY_BUFFER, ibo)
        gl.glBufferData(gl.GL_ELEMENT_ARRAY_BUFFER, idx.nbytes, idx, gl.GL_STATIC_DRAW)
        if instances is not None:
            ib = gl.glGenBuffers(1)
            gl.glBindBuffer(gl.GL_ARRAY_BUFFER, ib)
            gl.glBufferData(gl.GL_ARRAY_BUFFER, instances.nbytes, instances, gl.GL_STATIC_DRAW)
            gl.glEnableVertexAttribArray(3)
            gl.glVertexAttribPointer(3, 4, gl.GL_FLOAT, False, 16, None)
            gl.glVertexAttribDivisor(3, 1)
            self.instances = len(instances)
        gl.glBindVertexArray(0)

    def draw(self, instances=1):
        gl.glBindVertexArray(self.vao)
        if instances > 1:
            gl.glDrawElementsInstanced(gl.GL_TRIANGLES, self.count, gl.GL_UNSIGNED_INT, None, instances)
        else:
            gl.glDrawElements(gl.GL_TRIANGLES, self.count, gl.GL_UNSIGNED_INT, None)


# ---------------------------------------------------------------- resources

def gl_create(fn, *args):
    out = np.zeros(1, np.uint32)
    fn(*(args + (1, out)))
    return int(out[0])


def texture2d(label, w, h, fmt=gl.GL_RGBA8, data=None, mips=1):
    t = gl_create(gl.glCreateTextures, gl.GL_TEXTURE_2D)
    gl.glTextureStorage2D(t, mips, fmt, w, h)
    if data is not None:
        gl.glTextureSubImage2D(t, 0, 0, 0, w, h, gl.GL_RGBA, gl.GL_UNSIGNED_BYTE, data)
        if mips > 1:
            gl.glGenerateTextureMipmap(t)
    gl.glTextureParameteri(t, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR_MIPMAP_LINEAR if mips > 1 else gl.GL_LINEAR)
    gl.glTextureParameteri(t, gl.GL_TEXTURE_MAG_FILTER, gl.GL_LINEAR)
    gl.glTextureParameteri(t, gl.GL_TEXTURE_WRAP_S, gl.GL_REPEAT)
    gl.glTextureParameteri(t, gl.GL_TEXTURE_WRAP_T, gl.GL_REPEAT)
    gl.glObjectLabel(gl.GL_TEXTURE, t, len(label), label)
    return t


def noise_rgba(w, h, seed):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, (h, w, 4), dtype=np.uint8)


def framebuffer(label, color=None, depth=None):
    fb = gl_create(gl.glCreateFramebuffers)
    if color:
        gl.glNamedFramebufferTexture(fb, gl.GL_COLOR_ATTACHMENT0, color, 0)
    else:
        gl.glNamedFramebufferDrawBuffer(fb, gl.GL_NONE)
    if depth:
        gl.glNamedFramebufferTexture(fb, gl.GL_DEPTH_ATTACHMENT, depth, 0)
    assert gl.glCheckNamedFramebufferStatus(fb, gl.GL_FRAMEBUFFER) == gl.GL_FRAMEBUFFER_COMPLETE, label
    gl.glObjectLabel(gl.GL_FRAMEBUFFER, fb, len(label), label)
    return fb


def ubo(binding, label, nbytes):
    b = gl.glGenBuffers(1)
    gl.glBindBuffer(gl.GL_UNIFORM_BUFFER, b)
    gl.glBufferData(gl.GL_UNIFORM_BUFFER, nbytes, None, gl.GL_DYNAMIC_DRAW)
    gl.glBindBufferBase(gl.GL_UNIFORM_BUFFER, binding, b)
    gl.glObjectLabel(gl.GL_BUFFER, b, len(label), label)
    return b


def upload(buf, arr):
    arr = np.ascontiguousarray(arr, np.float32)
    gl.glBindBuffer(gl.GL_UNIFORM_BUFFER, buf)
    gl.glBufferSubData(gl.GL_UNIFORM_BUFFER, 0, arr.nbytes, arr)


def upload_raw(buf, raw):
    gl.glBindBuffer(gl.GL_UNIFORM_BUFFER, buf)
    gl.glBufferSubData(gl.GL_UNIFORM_BUFFER, 0, len(raw), raw)


class Marker:
    def __init__(self, name):
        self.name = name

    def __enter__(self):
        gl.glPushDebugGroup(gl.GL_DEBUG_SOURCE_APPLICATION, 0, len(self.name), self.name)

    def __exit__(self, *a):
        gl.glPopDebugGroup()


def perspective(fovy, aspect, n, f):
    t = 1 / math.tan(fovy / 2)
    return np.array([[t / aspect, 0, 0, 0], [0, t, 0, 0], [0, 0, (f + n) / (n - f), 2 * f * n / (n - f)], [0, 0, -1, 0]], np.float32)


def look_at(eye, target, up):
    eye, target, up = map(np.array, (eye, target, up))
    f = target - eye
    f = f / np.linalg.norm(f)
    s = np.cross(f, up)
    s = s / np.linalg.norm(s)
    u = np.cross(s, f)
    m = np.identity(4, np.float32)
    m[0, :3], m[1, :3], m[2, :3] = s, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


def ortho(r, n, f):
    m = np.identity(4, np.float32)
    m[0, 0] = m[1, 1] = 1 / r
    m[2, 2] = -2 / (f - n)
    m[2, 3] = -(f + n) / (f - n)
    return m


def trs(pos, scale):
    m = np.identity(4, np.float32)
    m[:3, :3] *= scale
    m[:3, 3] = pos
    return m


# ---------------------------------------------------------------- renderdoc

def renderdoc_api():
    # LD_PRELOADed librenderdoc exports RENDERDOC_GetAPI into the global namespace
    try:
        get_api = ctypes.CDLL(None).RENDERDOC_GetAPI
    except (OSError, AttributeError):
        return None
    get_api.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
    ptr = ctypes.c_void_p()
    if not get_api(10600, ctypes.byref(ptr)):
        return None
    table = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p * 32)).contents
    set_tpl = ctypes.CFUNCTYPE(None, ctypes.c_char_p)
    get_cap = ctypes.CFUNCTYPE(ctypes.c_uint32, ctypes.c_uint32, ctypes.c_char_p,
                               ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint64))
    return {
        "set_template": set_tpl(table[11]),
        "get_capture": get_cap(table[14]),
        "trigger": ctypes.CFUNCTYPE(None)(table[15]),
        "num_captures": ctypes.CFUNCTYPE(ctypes.c_uint32)(table[13]),
    }


# ---------------------------------------------------------------- frame

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=["a", "b"], default="a")
    ap.add_argument("--out", required=True, help="capture path template (without .rdc)")
    ap.add_argument("--no-labels", action="store_true", help="no program names (like Unity D3D11 captures)")
    args = ap.parse_args()
    global LABELS
    LABELS = not args.no_labels
    b = args.variant == "b"
    extra_lights = 24 if b else 4
    particles = 420 if b else 160
    taps = 25 if b else 9

    if not glfw.init():
        sys.exit("glfw init failed")
    glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 4)
    glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 5)
    glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
    win = glfw.create_window(W, H, "MiniURP", None, None)
    glfw.make_context_current(win)

    rdoc = renderdoc_api()
    if rdoc:
        rdoc["set_template"](args.out.encode())

    progs = {
        "lit": compile_program("Universal Render Pipeline/Lit", LIT_VS, LIT_FS),
        "shadow": compile_program("Universal Render Pipeline/Lit (ShadowCaster)", SHADOW_VS, SHADOW_FS),
        "sky": compile_program("Skybox/Procedural", FULLSCREEN_VS, SKY_FS),
        "particle": compile_program("Universal Render Pipeline/Particles/Unlit", PARTICLE_VS, PARTICLE_FS),
        "bloom": compile_program("Hidden/Universal Render Pipeline/Bloom", FULLSCREEN_VS, BLOOM_FS),
        "uber": compile_program("Hidden/Universal Render Pipeline/UberPost", FULLSCREEN_VS, UBER_FS),
        "ui": compile_program("UI/Default", UI_VS, UI_FS),
    }

    rocks = Mesh("Rock", sphere(24, 32))
    hero = Mesh("HeroStatue", sphere(300, 400))   # ~240k triangles
    crate = Mesh("Crate", cube())
    rng = np.random.default_rng(7)
    pinst = np.array([[rng.uniform(-0.6, 0.6), rng.uniform(-0.5, 0.5), rng.uniform(0.25, 0.6), rng.uniform(0.2, 0.6)]
                      for _ in range(particles)], np.float32)
    particles_mesh = Mesh("ParticleQuad", quad(), pinst)
    uinst = np.array([[-0.9 + 0.09 * i, 0.9, 0.04, 0.04] for i in range(20)], np.float32)
    ui_mesh = Mesh("UIQuad", quad(), uinst)
    empty_vao = gl.glGenVertexArrays(1)

    albedo = texture2d("Rock_Albedo", 512, 512, data=noise_rgba(512, 512, 1), mips=10)
    normal = texture2d("Rock_Normal", 512, 512, data=noise_rgba(512, 512, 2), mips=10)
    smoke = texture2d("SmokeSheet", 256, 256, data=noise_rgba(256, 256, 3), mips=9)
    uitex = texture2d("UI_Atlas", 128, 128, data=noise_rgba(128, 128, 4), mips=1)
    lut = gl_create(gl.glCreateTextures, gl.GL_TEXTURE_3D)
    gl.glTextureStorage3D(lut, 1, gl.GL_RGBA8, 32, 32, 32)
    gl.glTextureParameteri(lut, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR)
    gl.glObjectLabel(gl.GL_TEXTURE, lut, len("_InternalLut"), "_InternalLut")

    shadow_tex = texture2d("_MainLightShadowmapTexture", 2048, 2048, fmt=gl.GL_DEPTH_COMPONENT32F)
    color_tex = texture2d("_CameraColorAttachmentA", W, H, fmt=gl.GL_RGBA16F)
    depth_tex = texture2d("_CameraDepthAttachment", W, H, fmt=gl.GL_DEPTH24_STENCIL8)
    final_tex = texture2d("_CameraColorAttachmentB", W, H, fmt=gl.GL_RGBA8)
    shadow_fb = framebuffer("MainLightShadowmap", depth=shadow_tex)
    camera_fb = framebuffer("CameraTarget", color=color_tex, depth=depth_tex)
    final_fb = framebuffer("FinalTarget", color=final_tex)
    bloom_mips = []
    bw, bh = W // 2, H // 2
    for i in range(4):
        t = texture2d("_BloomMipDown%d" % i, bw, bh, fmt=gl.GL_RGBA16F)
        bloom_mips.append((t, framebuffer("BloomMip%d" % i, color=t), bw, bh))
        bw, bh = max(bw // 2, 1), max(bh // 2, 1)

    per_draw = ubo(0, "UnityPerDraw", 64)
    per_frame = ubo(1, "UnityPerFrame", 64 * 2 + 32)
    per_mat = ubo(2, "UnityPerMaterial", 48)
    lights = ubo(3, "AdditionalLights", 16 + 32 * 16 * 2)
    sky_ubo = ubo(4, "SkyboxParams", 48)
    part_ubo = ubo(5, "ParticlesUnlit", 32)
    bloom_ubo = ubo(6, "BloomParams", 48)
    uber_ubo = ubo(7, "UberPostParams", 48)
    ui_ubo = ubo(8, "UIDefault", 48)

    view = look_at((0, 3, 9), (0, 0.5, 0), (0, 1, 0))
    vp = perspective(math.radians(55), W / H, 0.1, 100) @ view
    light_vp = ortho(8, 0.1, 30) @ look_at((5, 10, 5), (0, 0, 0), (0, 1, 0))
    upload(per_frame, np.concatenate([vp.T.ravel(), light_vp.T.ravel(), [0.4, 0.8, 0.4, 0, 1, 1, 1, 1]]))
    lp = np.zeros((32, 4), np.float32)
    lc = np.zeros((32, 4), np.float32)
    for i in range(32):
        lp[i] = [rng.uniform(-6, 6), rng.uniform(0.5, 3), rng.uniform(-6, 6), 1]
        lc[i] = [rng.uniform(0.2, 1), rng.uniform(0.2, 1), rng.uniform(0.2, 1), 1]
    upload(lights, np.concatenate([[extra_lights, 0, 0, 0], lp.ravel(), lc.ravel()]))
    upload(sky_ubo, [0.5, 0.6, 0.9, 1, 0.3, 0.25, 0.2, 1, 1.2, 1.0, 0, 0])
    upload(part_ubo, [1, 0.9, 0.8, 0.8, 1, 2, 0, 0])
    bloom_raw = np.array([1, 1, 1, 1, 1.0 / W, 1.0 / H, W, H], np.float32).tobytes() + \
        np.array([taps], np.int32).tobytes() + np.array([0.8, 0.7, 1.0], np.float32).tobytes()
    upload_raw(bloom_ubo, bloom_raw)
    upload(uber_ubo, [1, 1, 1, 1, 0.6, 0, 0, 0, 0.8, 0.1, 0.002, 1.0])
    upload(ui_ubo, [1, 1, 1, 0.9, -1, -1, 1, 1, 0, 0, 0, 0])

    objects = []
    for i in range(36):
        x, z = (i % 6 - 2.5) * 1.6, (i // 6 - 2.5) * 1.6
        objects.append((rocks if i % 3 else crate, trs((x, 0.4, z), 0.6), "Rock_%02d" % i if i % 3 else "Crate_%02d" % i))
    objects.append((hero, trs((0, 1.2, 0), 1.2), "HeroStatue"))

    def draw_objects(prog, with_material):
        gl.glUseProgram(prog)
        for mesh, model, name in objects:
            with Marker("RenderLoop.Draw: " + name):
                upload(per_draw, model.T.ravel())
                if with_material:
                    upload(per_mat, [0.8, 0.8, 0.8, 1, 2, 2, 0, 0, 0.6, 0.2, 1.0, 1.0])
                mesh.draw()

    def fullscreen(prog):
        gl.glUseProgram(prog)
        gl.glBindVertexArray(empty_vao)
        gl.glDrawArrays(gl.GL_TRIANGLES, 0, 3)

    for frame in range(4):
        # TriggerCapture during frame 1 -> capture starts at frame 1's swap and covers frame 2
        if rdoc is not None and frame == 1:
            rdoc["trigger"]()

        with Marker("UniversalRenderPipeline.RenderSingleCameraInternal: Main Camera"):
            with Marker("MainLightShadow"):
                gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, shadow_fb)
                gl.glViewport(0, 0, 2048, 2048)
                gl.glEnable(gl.GL_DEPTH_TEST)
                gl.glDepthMask(True)
                gl.glClear(gl.GL_DEPTH_BUFFER_BIT)
                draw_objects(progs["shadow"], False)

            gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, camera_fb)
            gl.glViewport(0, 0, W, H)
            gl.glClearColor(0, 0, 0, 1)
            gl.glClear(gl.GL_COLOR_BUFFER_BIT | gl.GL_DEPTH_BUFFER_BIT)
            with Marker("DrawOpaqueObjects"):
                gl.glActiveTexture(gl.GL_TEXTURE0)
                gl.glBindTexture(gl.GL_TEXTURE_2D, albedo)
                gl.glActiveTexture(gl.GL_TEXTURE1)
                gl.glBindTexture(gl.GL_TEXTURE_2D, normal)
                gl.glActiveTexture(gl.GL_TEXTURE2)
                gl.glBindTexture(gl.GL_TEXTURE_2D, shadow_tex)
                gl.glEnable(gl.GL_CULL_FACE)
                draw_objects(progs["lit"], True)
                gl.glDisable(gl.GL_CULL_FACE)

            with Marker("DrawSkybox"):
                gl.glDepthFunc(gl.GL_LEQUAL)
                gl.glDepthMask(False)
                fullscreen(progs["sky"])
                gl.glDepthFunc(gl.GL_LESS)

            with Marker("DrawTransparentObjects"):
                gl.glEnable(gl.GL_BLEND)
                gl.glBlendFunc(gl.GL_SRC_ALPHA, gl.GL_ONE_MINUS_SRC_ALPHA)
                gl.glActiveTexture(gl.GL_TEXTURE0)
                gl.glBindTexture(gl.GL_TEXTURE_2D, smoke)
                gl.glUseProgram(progs["particle"])
                with Marker("ParticleSystem.Draw: Smoke"):
                    particles_mesh.draw(particles)
                gl.glDisable(gl.GL_BLEND)
                gl.glDepthMask(True)

            gl.glDisable(gl.GL_DEPTH_TEST)
            with Marker("PostProcessing"):
                with Marker("Bloom"):
                    src = color_tex
                    for i, (tex, fb, w, h) in enumerate(bloom_mips):
                        with Marker("Bloom Downsample %d" % i):
                            gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, fb)
                            gl.glViewport(0, 0, w, h)
                            gl.glActiveTexture(gl.GL_TEXTURE0)
                            gl.glBindTexture(gl.GL_TEXTURE_2D, src)
                            fullscreen(progs["bloom"])
                            src = tex
                with Marker("UberPost"):
                    gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, final_fb)
                    gl.glViewport(0, 0, W, H)
                    gl.glActiveTexture(gl.GL_TEXTURE0)
                    gl.glBindTexture(gl.GL_TEXTURE_2D, color_tex)
                    gl.glActiveTexture(gl.GL_TEXTURE1)
                    gl.glBindTexture(gl.GL_TEXTURE_2D, bloom_mips[0][0])
                    gl.glActiveTexture(gl.GL_TEXTURE2)
                    gl.glBindTexture(gl.GL_TEXTURE_3D, lut)
                    fullscreen(progs["uber"])

        with Marker("UGUI.Rendering.RenderOverlays"):
            gl.glEnable(gl.GL_BLEND)
            gl.glActiveTexture(gl.GL_TEXTURE0)
            gl.glBindTexture(gl.GL_TEXTURE_2D, uitex)
            gl.glUseProgram(progs["ui"])
            ui_mesh.draw(20)
            gl.glDisable(gl.GL_BLEND)

        with Marker("FinalBlit"):
            gl.glBindFramebuffer(gl.GL_READ_FRAMEBUFFER, final_fb)
            gl.glBindFramebuffer(gl.GL_DRAW_FRAMEBUFFER, 0)
            gl.glBlitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.GL_COLOR_BUFFER_BIT, gl.GL_NEAREST)
            gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)

        glfw.swap_buffers(win)
        glfw.poll_events()

    if rdoc is None:
        print("rendered without RenderDoc (no capture)")
    elif rdoc["num_captures"]() == 0:
        sys.exit("capture failed")
    else:
        buf = ctypes.create_string_buffer(1024)
        ln = ctypes.c_uint32(1024)
        ts = ctypes.c_uint64()
        rdoc["get_capture"](0, buf, ctypes.byref(ln), ctypes.byref(ts))
        print(buf.value.decode())
    glfw.terminate()


if __name__ == "__main__":
    main()
