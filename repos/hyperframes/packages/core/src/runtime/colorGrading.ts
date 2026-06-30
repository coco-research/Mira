import {
  HF_COLOR_GRADING_ATTR,
  isHfColorGradingActive,
  normalizeHfColorGrading,
  normalizeHfColorGradingWithVariables,
  type HfColorGradingVariableMap,
  type HfColorGradingTarget,
  type NormalizedHfColorGrading,
} from "../colorGrading";
import { packCubeLutToRgba8, parseCubeLut, type CubeLut3D, type CubeLutVec3 } from "../colorLuts";
import { copyMediaVisualStyles } from "../inline-scripts/parityContract";
import { swallow } from "./diagnostics";

type ColorGradingMediaElement = HTMLVideoElement | HTMLImageElement;

type EntrySource = "attribute" | "live";

interface VideoFrameCallbackMetadata {
  mediaTime: number;
  presentedFrames: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
}

type VideoFrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

interface VideoFrameCallbackHost {
  requestVideoFrameCallback?: (callback: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

interface ProgramInfo {
  program: WebGLProgram;
  texture: WebGLTexture;
  lutTexture: WebGLTexture;
  position: number;
  source: WebGLUniformLocation | null;
  lut: WebGLUniformLocation | null;
  resolution: WebGLUniformLocation | null;
  uvScale: WebGLUniformLocation | null;
  uvOffset: WebGLUniformLocation | null;
  lutEnabled: WebGLUniformLocation | null;
  lutSize: WebGLUniformLocation | null;
  lutTextureSize: WebGLUniformLocation | null;
  lutDomainMin: WebGLUniformLocation | null;
  lutDomainMax: WebGLUniformLocation | null;
  lutIntensity: WebGLUniformLocation | null;
  exposure: WebGLUniformLocation | null;
  contrast: WebGLUniformLocation | null;
  highlights: WebGLUniformLocation | null;
  shadows: WebGLUniformLocation | null;
  whites: WebGLUniformLocation | null;
  blacks: WebGLUniformLocation | null;
  temperature: WebGLUniformLocation | null;
  tint: WebGLUniformLocation | null;
  saturation: WebGLUniformLocation | null;
  intensity: WebGLUniformLocation | null;
  compareEnabled: WebGLUniformLocation | null;
  comparePosition: WebGLUniformLocation | null;
  compareSoftness: WebGLUniformLocation | null;
  compareLineWidth: WebGLUniformLocation | null;
}

interface RuntimeColorGradingCompareState {
  enabled: boolean;
  position: number;
  softness: number;
  lineWidth: number;
}

interface ColorGradingEntry {
  element: ColorGradingMediaElement;
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: ProgramInfo;
  grading: NormalizedHfColorGrading;
  compare: RuntimeColorGradingCompareState;
  lut: RuntimeLutTexture | null;
  lutLoadingSrc: string | null;
  lutError: string | null;
  source: EntrySource;
  animationFrame: number | null;
  videoFrameHandle: number | null;
  resizeObserver: ResizeObserver | null;
  cleanup: Array<() => void>;
  touchedParent: HTMLElement | null;
  parentInlinePosition: string | null;
  sourceHidden: boolean;
  sourceInlineOpacity: string | null;
  sourceInlineOpacityPriority: string;
  sourceOpacityForCanvas: string;
  sourceVisibleForCanvas: boolean;
  hasDrawn: boolean;
  destroyed: boolean;
}

export interface RuntimeColorGradingApi {
  refresh: () => number;
  redraw: () => number;
  setGrading: (
    target: HfColorGradingTarget | string | null | undefined,
    rawGrading: unknown,
  ) => boolean;
  setCompare: (
    target: HfColorGradingTarget | string | null | undefined,
    rawCompare: unknown,
  ) => boolean;
  setSourceVisibility: (target: Element, visible: boolean) => boolean;
  getStatus: (
    target: HfColorGradingTarget | string | null | undefined,
  ) => RuntimeColorGradingStatus;
  destroy: () => void;
}

export type RuntimeColorGradingStatus =
  | { state: "missing"; message: string }
  | { state: "inactive"; message: string }
  | { state: "pending"; message: string }
  | { state: "active"; message: string }
  | { state: "unavailable"; message: string };

type WindowWithColorGrading = Window & {
  __hf?: {
    colorGrading?: RuntimeColorGradingApi;
  };
  __hyperframes?: {
    getVariables?: () => Partial<Record<string, unknown>>;
  };
  __hfVariables?: Record<string, unknown>;
  __hfVariablesByComp?: Record<string, Record<string, unknown>>;
};

interface RuntimeLutTexture {
  src: string;
  title: string | null;
  size: number;
  domainMin: CubeLutVec3;
  domainMax: CubeLutVec3;
  textureWidth: number;
  textureHeight: number;
}

type LutCacheEntry =
  | { state: "pending"; promise: Promise<CubeLut3D> }
  | { state: "ready"; lut: CubeLut3D }
  | { state: "error"; message: string };

const LUT_CACHE = new Map<string, LutCacheEntry>();
const COLOR_GRADING_CANVAS_ATTR = "data-hf-color-grading-canvas";
const COLOR_GRADING_SOURCE_HIDDEN_ATTR = "data-hf-color-grading-source-hidden";
const COLOR_GRADING_CANVAS_CLASS = "__hf_color_grading_canvas__";
const MAX_LUT_SIZE = 64;
const DEFAULT_COMPARE: RuntimeColorGradingCompareState = {
  enabled: false,
  position: 0.5,
  softness: 0,
  lineWidth: 2,
};

function readVariablesForElement(element: Element): HfColorGradingVariableMap {
  const win = window as WindowWithColorGrading;
  const scope = element.closest("[data-composition-id]");
  const compositionId = scope?.getAttribute("data-composition-id")?.trim() ?? "";
  const scoped = compositionId ? win.__hfVariablesByComp?.[compositionId] : undefined;
  if (scoped) return scoped;

  const fromHelper = win.__hyperframes?.getVariables?.();
  if (fromHelper && typeof fromHelper === "object") {
    return fromHelper;
  }
  return win.__hfVariables ?? {};
}

function readColorGradingAttribute(element: Element): NormalizedHfColorGrading | null {
  const raw = element.getAttribute(HF_COLOR_GRADING_ATTR);
  if (raw == null) return null;
  return normalizeHfColorGradingWithVariables(raw, readVariablesForElement(element));
}

const VERTEX_SHADER = [
  "attribute vec2 a_pos;",
  "varying vec2 v_uv;",
  "void main(){",
  "  v_uv = a_pos * 0.5 + 0.5;",
  "  gl_Position = vec4(a_pos, 0.0, 1.0);",
  "}",
].join("\n");

const FRAGMENT_SHADER = [
  "#ifdef GL_FRAGMENT_PRECISION_HIGH",
  "precision highp float;",
  "#else",
  "precision mediump float;",
  "#endif",
  "varying vec2 v_uv;",
  "uniform sampler2D u_source;",
  "uniform sampler2D u_lut;",
  "uniform vec2 u_resolution;",
  "uniform vec2 u_uvScale;",
  "uniform vec2 u_uvOffset;",
  "uniform float u_lutEnabled;",
  "uniform float u_lutSize;",
  "uniform vec2 u_lutTextureSize;",
  "uniform vec3 u_lutDomainMin;",
  "uniform vec3 u_lutDomainMax;",
  "uniform float u_lutIntensity;",
  "uniform float u_exposure;",
  "uniform float u_contrast;",
  "uniform float u_highlights;",
  "uniform float u_shadows;",
  "uniform float u_whites;",
  "uniform float u_blacks;",
  "uniform float u_temperature;",
  "uniform float u_tint;",
  "uniform float u_saturation;",
  "uniform float u_intensity;",
  "uniform float u_compareEnabled;",
  "uniform float u_comparePosition;",
  "uniform float u_compareSoftness;",
  "uniform float u_compareLineWidth;",
  "float lumaOf(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }",
  "vec3 sampleLut(float r, float g, float b){",
  "  float size = max(u_lutSize, 2.0);",
  "  float x = (r + b * size + 0.5) / max(u_lutTextureSize.x, 1.0);",
  "  float y = (g + 0.5) / max(u_lutTextureSize.y, 1.0);",
  "  return texture2D(u_lut, vec2(x, y)).rgb;",
  "}",
  "vec3 applyLut(vec3 color){",
  "  if (u_lutEnabled < 0.5) return color;",
  "  float size = max(u_lutSize, 2.0);",
  "  vec3 span = max(u_lutDomainMax - u_lutDomainMin, vec3(0.00001));",
  "  vec3 scaled = clamp((color - u_lutDomainMin) / span, 0.0, 1.0) * (size - 1.0);",
  "  vec3 lo = floor(scaled);",
  "  vec3 hi = min(lo + 1.0, vec3(size - 1.0));",
  "  vec3 f = scaled - lo;",
  "  vec3 c000 = sampleLut(lo.r, lo.g, lo.b);",
  "  vec3 c100 = sampleLut(hi.r, lo.g, lo.b);",
  "  vec3 c010 = sampleLut(lo.r, hi.g, lo.b);",
  "  vec3 c110 = sampleLut(hi.r, hi.g, lo.b);",
  "  vec3 c001 = sampleLut(lo.r, lo.g, hi.b);",
  "  vec3 c101 = sampleLut(hi.r, lo.g, hi.b);",
  "  vec3 c011 = sampleLut(lo.r, hi.g, hi.b);",
  "  vec3 c111 = sampleLut(hi.r, hi.g, hi.b);",
  "  vec3 c00 = mix(c000, c100, f.r);",
  "  vec3 c10 = mix(c010, c110, f.r);",
  "  vec3 c01 = mix(c001, c101, f.r);",
  "  vec3 c11 = mix(c011, c111, f.r);",
  "  vec3 c0 = mix(c00, c10, f.g);",
  "  vec3 c1 = mix(c01, c11, f.g);",
  "  vec3 lutColor = mix(c0, c1, f.b);",
  "  return mix(color, lutColor, clamp(u_lutIntensity, 0.0, 1.0));",
  "}",
  "void main(){",
  "  vec2 uv = (v_uv - u_uvOffset) / u_uvScale;",
  "  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {",
  "    gl_FragColor = vec4(0.0);",
  "    return;",
  "  }",
  "  vec4 sampleColor = texture2D(u_source, uv);",
  "  vec3 original = sampleColor.rgb;",
  "  vec3 color = original * pow(2.0, u_exposure);",
  "  float y = lumaOf(color);",
  "  float shadowMask = 1.0 - smoothstep(0.0, 0.65, y);",
  "  float highlightMask = smoothstep(0.35, 1.0, y);",
  "  color += u_shadows * 0.35 * shadowMask;",
  "  color += u_highlights * 0.35 * highlightMask;",
  "  color += u_blacks * 0.25 * (1.0 - smoothstep(0.0, 0.35, y));",
  "  color += u_whites * 0.25 * smoothstep(0.65, 1.0, y);",
  "  color.r += u_temperature * 0.08 + u_tint * 0.04;",
  "  color.b -= u_temperature * 0.08 - u_tint * 0.04;",
  "  color.g -= u_tint * 0.08;",
  "  color = (color - 0.5) * max(0.0, 1.0 + u_contrast) + 0.5;",
  "  float satLuma = lumaOf(color);",
  "  color = mix(vec3(satLuma), color, max(0.0, 1.0 + u_saturation));",
  "  color = clamp(color, 0.0, 1.0);",
  "  color = clamp(applyLut(color), 0.0, 1.0);",
  "  vec3 graded = mix(original, color, u_intensity);",
  "  if (u_compareEnabled > 0.5) {",
  "    float pos = clamp(u_comparePosition, 0.0, 1.0);",
  "    float softness = max(u_compareSoftness, 0.00001);",
  "    float afterMask = smoothstep(pos - softness, pos + softness, v_uv.x);",
  "    vec3 splitColor = mix(original, graded, afterMask);",
  "    float lineMask = 0.0;",
  "    if (u_compareLineWidth > 0.0) {",
  "      float lineWidth = max(u_compareLineWidth / max(u_resolution.x, 1.0), 0.00001);",
  "      lineMask = 1.0 - smoothstep(lineWidth, lineWidth * 1.8, abs(v_uv.x - pos));",
  "    }",
  "    gl_FragColor = vec4(mix(splitColor, vec3(1.0), lineMask * 0.82), sampleColor.a);",
  "    return;",
  "  }",
  "  gl_FragColor = vec4(graded, sampleColor.a);",
  "}",
].join("\n");

function isColorGradingMediaElement(value: Element): value is ColorGradingMediaElement {
  return value instanceof HTMLVideoElement || value instanceof HTMLImageElement;
}

function compileShader(
  gl: WebGLRenderingContext,
  source: string,
  type: number,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    swallow("runtime.colorGrading.compileShader", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, VERTEX_SHADER, gl.VERTEX_SHADER);
  const fragment = compileShader(gl, FRAGMENT_SHADER, gl.FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    swallow("runtime.colorGrading.linkProgram", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function createTexture(gl: WebGLRenderingContext, filter = gl.LINEAR): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return texture;
}

function createProgramInfo(canvas: HTMLCanvasElement): {
  gl: WebGLRenderingContext;
  program: ProgramInfo;
} | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;
  const program = createProgram(gl);
  const texture = createTexture(gl);
  const lutTexture = createTexture(gl, gl.NEAREST);
  if (!program || !texture || !lutTexture) {
    if (program) gl.deleteProgram(program);
    if (texture) gl.deleteTexture(texture);
    if (lutTexture) gl.deleteTexture(lutTexture);
    return null;
  }
  const quad = gl.createBuffer();
  if (!quad) {
    gl.deleteProgram(program);
    gl.deleteTexture(texture);
    gl.deleteTexture(lutTexture);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  return {
    gl,
    program: {
      program,
      texture,
      lutTexture,
      position: gl.getAttribLocation(program, "a_pos"),
      source: gl.getUniformLocation(program, "u_source"),
      lut: gl.getUniformLocation(program, "u_lut"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      uvScale: gl.getUniformLocation(program, "u_uvScale"),
      uvOffset: gl.getUniformLocation(program, "u_uvOffset"),
      lutEnabled: gl.getUniformLocation(program, "u_lutEnabled"),
      lutSize: gl.getUniformLocation(program, "u_lutSize"),
      lutTextureSize: gl.getUniformLocation(program, "u_lutTextureSize"),
      lutDomainMin: gl.getUniformLocation(program, "u_lutDomainMin"),
      lutDomainMax: gl.getUniformLocation(program, "u_lutDomainMax"),
      lutIntensity: gl.getUniformLocation(program, "u_lutIntensity"),
      exposure: gl.getUniformLocation(program, "u_exposure"),
      contrast: gl.getUniformLocation(program, "u_contrast"),
      highlights: gl.getUniformLocation(program, "u_highlights"),
      shadows: gl.getUniformLocation(program, "u_shadows"),
      whites: gl.getUniformLocation(program, "u_whites"),
      blacks: gl.getUniformLocation(program, "u_blacks"),
      temperature: gl.getUniformLocation(program, "u_temperature"),
      tint: gl.getUniformLocation(program, "u_tint"),
      saturation: gl.getUniformLocation(program, "u_saturation"),
      intensity: gl.getUniformLocation(program, "u_intensity"),
      compareEnabled: gl.getUniformLocation(program, "u_compareEnabled"),
      comparePosition: gl.getUniformLocation(program, "u_comparePosition"),
      compareSoftness: gl.getUniformLocation(program, "u_compareSoftness"),
      compareLineWidth: gl.getUniformLocation(program, "u_compareLineWidth"),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCompare(raw: unknown): RuntimeColorGradingCompareState {
  if (!isRecord(raw)) return { ...DEFAULT_COMPARE };
  const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
  };
  return {
    enabled: raw.enabled === true,
    position: clampNumber(raw.position, DEFAULT_COMPARE.position, 0, 1),
    softness: clampNumber(raw.softness, DEFAULT_COMPARE.softness, 0, 0.25),
    lineWidth: clampNumber(raw.lineWidth, DEFAULT_COMPARE.lineWidth, 0, 12),
  };
}

function resolveLutUrl(src: string): { href: string } | { error: string } {
  try {
    const url = new URL(src, document.baseURI);
    if (url.protocol === "data:") return { href: url.href };
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "LUT must be project-local or a data URL" };
    }
    if (url.origin !== window.location.origin) {
      return { error: "Remote LUT URLs are not supported" };
    }
    return { href: url.href };
  } catch {
    return { error: "Invalid LUT URL" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "LUT failed to load";
}

function getCubeLut(src: string): LutCacheEntry {
  const resolved = resolveLutUrl(src);
  if ("error" in resolved) return { state: "error", message: resolved.error };
  const cached = LUT_CACHE.get(resolved.href);
  if (cached) return cached;

  const promise = fetch(resolved.href, { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load LUT (${response.status})`);
      return response.text();
    })
    .then((text) => parseCubeLut(text, { maxSize: MAX_LUT_SIZE }));

  const pending: LutCacheEntry = { state: "pending", promise };
  LUT_CACHE.set(resolved.href, pending);
  promise.then(
    (lut) => LUT_CACHE.set(resolved.href, { state: "ready", lut }),
    (err) => LUT_CACHE.set(resolved.href, { state: "error", message: errorMessage(err) }),
  );
  return pending;
}

function uploadEntryLut(
  entry: ColorGradingEntry,
  src: string,
  lut: CubeLut3D,
): RuntimeLutTexture | null {
  if (entry.lut?.src === src) return entry.lut;
  const packed = packCubeLutToRgba8(lut);
  const { gl, program } = entry;
  try {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, program.lutTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      packed.width,
      packed.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      packed.data,
    );
    entry.lut = {
      src,
      title: lut.title,
      size: lut.size,
      domainMin: lut.domainMin,
      domainMax: lut.domainMax,
      textureWidth: packed.width,
      textureHeight: packed.height,
    };
    entry.lutError = null;
    entry.lutLoadingSrc = null;
    return entry.lut;
  } catch (err) {
    entry.lut = null;
    entry.lutError = errorMessage(err);
    entry.lutLoadingSrc = null;
    swallow("runtime.colorGrading.uploadLut", err);
    return null;
  }
}

// fallow-ignore-next-line complexity
function ensureEntryLut(entry: ColorGradingEntry): RuntimeLutTexture | null {
  const src = entry.grading.lut?.src.trim() ?? "";
  const intensity = entry.grading.lut?.intensity ?? 1;
  if (!src || intensity <= 0) {
    entry.lut = null;
    entry.lutLoadingSrc = null;
    entry.lutError = null;
    return null;
  }

  const resolved = resolveLutUrl(src);
  if ("error" in resolved) {
    entry.lut = null;
    entry.lutLoadingSrc = null;
    entry.lutError = resolved.error;
    return null;
  }
  if (entry.lut?.src === resolved.href) return entry.lut;
  entry.lut = null;

  const cached = getCubeLut(src);
  if (cached.state === "ready") return uploadEntryLut(entry, resolved.href, cached.lut);
  if (cached.state === "error") {
    entry.lutError = cached.message;
    entry.lutLoadingSrc = null;
    return null;
  }

  if (entry.lutLoadingSrc !== resolved.href) {
    entry.lutLoadingSrc = resolved.href;
    entry.lutError = null;
    cached.promise.then(
      (lut) => {
        if (entry.destroyed || entry.grading.lut?.src.trim() !== src) return;
        uploadEntryLut(entry, resolved.href, lut);
        drawEntry(entry);
      },
      (err) => {
        if (entry.destroyed || entry.grading.lut?.src.trim() !== src) return;
        entry.lut = null;
        entry.lutError = errorMessage(err);
        entry.lutLoadingSrc = null;
        drawEntry(entry);
      },
    );
  }
  return null;
}

// fallow-ignore-next-line complexity
function resolveTarget(
  target: HfColorGradingTarget | string | null | undefined,
): ColorGradingMediaElement | null {
  if (!target) return null;
  if (typeof target === "string") {
    const trimmed = target.trim();
    if (!trimmed) return null;
    const byId = document.getElementById(trimmed.replace(/^#/, ""));
    if (byId && isColorGradingMediaElement(byId)) return byId;
    try {
      const bySelector = document.querySelector(trimmed);
      return bySelector && isColorGradingMediaElement(bySelector) ? bySelector : null;
    } catch {
      return null;
    }
  }
  if (target.hfId) {
    const byHfId = document.querySelector(`[data-hf-id="${CSS.escape(target.hfId)}"]`);
    if (byHfId && isColorGradingMediaElement(byHfId)) return byHfId;
  }
  if (target.id) {
    const byId = document.getElementById(target.id);
    if (byId && isColorGradingMediaElement(byId)) return byId;
  }
  if (!target.selector) return null;
  try {
    const matches = Array.from(document.querySelectorAll(target.selector));
    const index = Math.max(0, Math.floor(Number(target.selectorIndex ?? 0) || 0));
    const match = matches[index] ?? null;
    return match && isColorGradingMediaElement(match) ? match : null;
  } catch {
    return null;
  }
}

function readSourceSize(source: TexImageSource): { width: number; height: number } | null {
  if (source instanceof HTMLVideoElement) {
    return source.videoWidth > 0 && source.videoHeight > 0
      ? { width: source.videoWidth, height: source.videoHeight }
      : null;
  }
  if (source instanceof HTMLImageElement) {
    return source.naturalWidth > 0 && source.naturalHeight > 0
      ? { width: source.naturalWidth, height: source.naturalHeight }
      : null;
  }
  return null;
}

function isDrawableSource(source: TexImageSource): boolean {
  if (source instanceof HTMLVideoElement) {
    return (
      source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      source.videoWidth > 0 &&
      source.videoHeight > 0
    );
  }
  if (source instanceof HTMLImageElement) {
    return source.complete && source.naturalWidth > 0 && source.naturalHeight > 0;
  }
  return false;
}

function findRenderFrameImage(video: HTMLVideoElement): HTMLImageElement | null {
  if (!video.id) return null;
  const frame = document.getElementById(`__render_frame_${video.id}__`);
  return frame instanceof HTMLImageElement && isDrawableSource(frame) ? frame : null;
}

function getDrawableSource(element: ColorGradingMediaElement): TexImageSource | null {
  if (element instanceof HTMLVideoElement) {
    const renderFrame = findRenderFrameImage(element);
    if (renderFrame) return renderFrame;
  }
  return isDrawableSource(element) ? element : null;
}

function parseObjectPositionPart(value: string, axis: "x" | "y"): number | null {
  const lower = value.toLowerCase();
  if (lower === "center") return 0.5;
  if (axis === "x") {
    if (lower === "left") return 0;
    if (lower === "right") return 1;
  } else {
    if (lower === "top") return 0;
    if (lower === "bottom") return 1;
  }
  if (lower.endsWith("%")) {
    const parsed = Number.parseFloat(lower);
    return Number.isFinite(parsed) ? parsed / 100 : null;
  }
  return null;
}

// fallow-ignore-next-line complexity
function parseObjectPosition(value: string): { x: number; y: number } {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  let x = 0.5;
  let y = 0.5;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const xValue = parseObjectPositionPart(token, "x");
    const yValue = parseObjectPositionPart(token, "y");
    if (
      xValue !== null &&
      (token === "left" || token === "right" || (token.endsWith("%") && index === 0))
    ) {
      x = xValue;
      continue;
    }
    if (
      yValue !== null &&
      (token === "top" || token === "bottom" || (token.endsWith("%") && index > 0))
    ) {
      y = yValue;
      continue;
    }
  }
  return { x, y };
}

// fallow-ignore-next-line complexity
function calculateObjectFitUv(
  boxWidth: number,
  boxHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  objectFit: string,
  objectPosition: string,
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  if (boxWidth <= 0 || boxHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }
  const fit = objectFit || "fill";
  let drawWidth = boxWidth;
  let drawHeight = boxHeight;
  if (fit === "contain" || fit === "cover" || fit === "scale-down") {
    const scale =
      fit === "cover"
        ? Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
        : Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
    drawWidth = sourceWidth * scale;
    drawHeight = sourceHeight * scale;
    if (fit === "scale-down" && drawWidth > sourceWidth && drawHeight > sourceHeight) {
      drawWidth = sourceWidth;
      drawHeight = sourceHeight;
    }
  } else if (fit === "none") {
    drawWidth = sourceWidth;
    drawHeight = sourceHeight;
  }
  const position = parseObjectPosition(objectPosition || "center");
  const offsetX = ((boxWidth - drawWidth) * position.x) / boxWidth;
  const offsetY = ((boxHeight - drawHeight) * position.y) / boxHeight;
  return {
    scaleX: drawWidth / boxWidth,
    scaleY: drawHeight / boxHeight,
    offsetX,
    offsetY,
  };
}

function ensureParentPosition(entry: ColorGradingEntry, parent: HTMLElement): void {
  const computed = window.getComputedStyle(parent);
  if (computed.position !== "static") return;
  if (!entry.touchedParent) {
    entry.touchedParent = parent;
    entry.parentInlinePosition = parent.style.position || null;
  }
  parent.style.position = "relative";
}

function updateCanvasLayout(
  entry: ColorGradingEntry,
  styleSource: HTMLElement,
): { width: number; height: number } | null {
  const { element, canvas } = entry;
  const parent = element.parentElement;
  if (parent) ensureParentPosition(entry, parent);

  const computed = window.getComputedStyle(styleSource);
  copyMediaVisualStyles(canvas.style, computed);
  canvas.style.pointerEvents = "none";
  canvas.style.position = "absolute";
  canvas.style.inset = "auto";
  canvas.style.left = `${element.offsetLeft}px`;
  canvas.style.top = `${element.offsetTop}px`;
  canvas.style.right = "auto";
  canvas.style.bottom = "auto";
  canvas.style.width = `${element.offsetWidth}px`;
  canvas.style.height = `${element.offsetHeight}px`;
  canvas.style.display = "block";
  canvas.style.opacity = entry.sourceOpacityForCanvas;
  canvas.style.visibility = entry.sourceVisibleForCanvas ? "visible" : "hidden";

  const rect = element.getBoundingClientRect();
  const width = Math.max(0, Math.round(element.offsetWidth || rect.width));
  const height = Math.max(0, Math.round(element.offsetHeight || rect.height));
  if (width <= 0 || height <= 0) {
    canvas.style.display = "none";
    return null;
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height };
}

// fallow-ignore-next-line complexity
function applyUniforms(
  gl: WebGLRenderingContext,
  program: ProgramInfo,
  grading: NormalizedHfColorGrading,
  lut: RuntimeLutTexture | null,
  compare: RuntimeColorGradingCompareState,
  layout: { width: number; height: number },
  uv: { scaleX: number; scaleY: number; offsetX: number; offsetY: number },
): void {
  gl.uniform1i(program.source, 0);
  gl.uniform1i(program.lut, 1);
  gl.uniform2f(program.resolution, layout.width, layout.height);
  gl.uniform2f(program.uvScale, uv.scaleX, uv.scaleY);
  gl.uniform2f(program.uvOffset, uv.offsetX, uv.offsetY);
  gl.uniform1f(program.lutEnabled, lut ? 1 : 0);
  gl.uniform1f(program.lutSize, lut?.size ?? 2);
  gl.uniform2f(program.lutTextureSize, lut?.textureWidth ?? 1, lut?.textureHeight ?? 1);
  gl.uniform3f(
    program.lutDomainMin,
    lut?.domainMin[0] ?? 0,
    lut?.domainMin[1] ?? 0,
    lut?.domainMin[2] ?? 0,
  );
  gl.uniform3f(
    program.lutDomainMax,
    lut?.domainMax[0] ?? 1,
    lut?.domainMax[1] ?? 1,
    lut?.domainMax[2] ?? 1,
  );
  gl.uniform1f(program.lutIntensity, grading.lut?.intensity ?? 0);
  gl.uniform1f(program.exposure, grading.adjust.exposure);
  gl.uniform1f(program.contrast, grading.adjust.contrast);
  gl.uniform1f(program.highlights, grading.adjust.highlights);
  gl.uniform1f(program.shadows, grading.adjust.shadows);
  gl.uniform1f(program.whites, grading.adjust.whites);
  gl.uniform1f(program.blacks, grading.adjust.blacks);
  gl.uniform1f(program.temperature, grading.adjust.temperature);
  gl.uniform1f(program.tint, grading.adjust.tint);
  gl.uniform1f(program.saturation, grading.adjust.saturation);
  gl.uniform1f(program.intensity, grading.intensity);
  gl.uniform1f(program.compareEnabled, compare.enabled ? 1 : 0);
  gl.uniform1f(program.comparePosition, compare.position);
  gl.uniform1f(program.compareSoftness, compare.softness);
  gl.uniform1f(program.compareLineWidth, compare.lineWidth);
}

function hideSourceElement(entry: ColorGradingEntry): void {
  if (!entry.sourceHidden) {
    entry.sourceInlineOpacity = entry.element.style.getPropertyValue("opacity") || null;
    entry.sourceInlineOpacityPriority = entry.element.style.getPropertyPriority("opacity");
  }
  entry.element.setAttribute(COLOR_GRADING_SOURCE_HIDDEN_ATTR, "true");
  entry.element.style.setProperty("opacity", "0", "important");
  entry.sourceHidden = true;
}

// fallow-ignore-next-line complexity
function drawEntry(entry: ColorGradingEntry): boolean {
  if (entry.destroyed) return false;
  const source = getDrawableSource(entry.element);
  if (!source) {
    if (!entry.hasDrawn) entry.canvas.style.display = "none";
    return false;
  }
  const sourceSize = readSourceSize(source);
  if (!sourceSize) return false;
  const styleSource = source instanceof HTMLElement ? source : entry.element;
  const sourceOpacity = entry.element.style.getPropertyValue("opacity");
  const sourceOpacityPriority = entry.element.style.getPropertyPriority("opacity");
  const hiddenByColorGrading =
    entry.sourceHidden && sourceOpacity === "0" && sourceOpacityPriority === "important";
  const sourceVisibility = entry.element.style.getPropertyValue("visibility");
  if (!hiddenByColorGrading) {
    const computed = window.getComputedStyle(entry.element);
    entry.sourceOpacityForCanvas = computed.opacity || "1";
    entry.sourceVisibleForCanvas =
      sourceVisibility !== "hidden" && computed.visibility !== "hidden";
  }
  const layout = updateCanvasLayout(entry, styleSource);
  if (!layout) return false;

  const style = window.getComputedStyle(styleSource);
  const uv = calculateObjectFitUv(
    layout.width,
    layout.height,
    sourceSize.width,
    sourceSize.height,
    style.objectFit,
    style.objectPosition,
  );
  const { gl, program } = entry;
  try {
    const lut = ensureEntryLut(entry);
    gl.viewport(0, 0, layout.width, layout.height);
    gl.useProgram(program.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, program.texture);
    // Browser media elements are top-left oriented; WebGL texture coordinates
    // are bottom-left oriented unless the upload is flipped.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, program.lutTexture);
    applyUniforms(gl, program, entry.grading, lut, entry.compare, layout, uv);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    hideSourceElement(entry);
    entry.hasDrawn = true;
    return true;
  } catch (err) {
    swallow("runtime.colorGrading.drawEntry", err);
    return false;
  }
}

function addListener(
  entry: ColorGradingEntry,
  target: EventTarget,
  type: string,
  listener: EventListener,
): void {
  target.addEventListener(type, listener);
  entry.cleanup.push(() => target.removeEventListener(type, listener));
}

function cancelScheduledFrame(entry: ColorGradingEntry): void {
  if (entry.animationFrame !== null) {
    window.cancelAnimationFrame(entry.animationFrame);
    entry.animationFrame = null;
  }
  if (entry.videoFrameHandle !== null && entry.element instanceof HTMLVideoElement) {
    const videoFrameHost: VideoFrameCallbackHost = entry.element;
    videoFrameHost.cancelVideoFrameCallback?.(entry.videoFrameHandle);
    entry.videoFrameHandle = null;
  }
}

function scheduleVideoDraw(entry: ColorGradingEntry): void {
  if (entry.destroyed || !(entry.element instanceof HTMLVideoElement)) return;
  if (entry.videoFrameHandle !== null || entry.animationFrame !== null) return;
  const video = entry.element;
  const videoFrameHost: VideoFrameCallbackHost = video;
  if (typeof videoFrameHost.requestVideoFrameCallback === "function") {
    entry.videoFrameHandle = videoFrameHost.requestVideoFrameCallback(() => {
      entry.videoFrameHandle = null;
      drawEntry(entry);
      if (!entry.destroyed && !video.paused && !video.ended) scheduleVideoDraw(entry);
    });
    return;
  }
  entry.animationFrame = window.requestAnimationFrame(() => {
    entry.animationFrame = null;
    drawEntry(entry);
    if (!entry.destroyed && !video.paused && !video.ended) scheduleVideoDraw(entry);
  });
}

function installEntryListeners(entry: ColorGradingEntry): void {
  const redraw = () => {
    drawEntry(entry);
  };
  addListener(entry, entry.element, "load", redraw);
  addListener(entry, entry.element, "loadedmetadata", redraw);
  addListener(entry, entry.element, "loadeddata", redraw);
  addListener(entry, entry.element, "seeked", redraw);
  addListener(entry, entry.element, "timeupdate", redraw);
  addListener(entry, window, "resize", redraw);
  if (entry.element instanceof HTMLVideoElement) {
    addListener(entry, entry.element, "play", () => scheduleVideoDraw(entry));
    addListener(entry, entry.element, "pause", redraw);
  }
  if (typeof ResizeObserver !== "undefined") {
    entry.resizeObserver = new ResizeObserver(redraw);
    entry.resizeObserver.observe(entry.element);
  }
}

function destroyEntry(entry: ColorGradingEntry): void {
  if (entry.destroyed) return;
  entry.destroyed = true;
  cancelScheduledFrame(entry);
  entry.resizeObserver?.disconnect();
  for (const cleanup of entry.cleanup) cleanup();
  entry.cleanup.length = 0;
  entry.canvas.remove();
  entry.gl.deleteTexture(entry.program.texture);
  entry.gl.deleteTexture(entry.program.lutTexture);
  entry.gl.deleteProgram(entry.program.program);
  if (entry.sourceHidden) {
    entry.element.removeAttribute(COLOR_GRADING_SOURCE_HIDDEN_ATTR);
    const opacity = entry.element.style.getPropertyValue("opacity");
    const priority = entry.element.style.getPropertyPriority("opacity");
    if (opacity === "0" && priority === "important") {
      if (entry.sourceInlineOpacity === null) {
        entry.element.style.removeProperty("opacity");
      } else {
        entry.element.style.setProperty(
          "opacity",
          entry.sourceInlineOpacity,
          entry.sourceInlineOpacityPriority,
        );
      }
    }
  }
  if (entry.touchedParent) {
    if (entry.parentInlinePosition === null) {
      entry.touchedParent.style.removeProperty("position");
    } else {
      entry.touchedParent.style.position = entry.parentInlinePosition;
    }
  }
}

function makeCanvas(element: ColorGradingMediaElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = COLOR_GRADING_CANVAS_CLASS;
  canvas.setAttribute(COLOR_GRADING_CANVAS_ATTR, "true");
  canvas.setAttribute("data-hyperframes-ignore", "");
  canvas.setAttribute("data-hyperframes-picker-ignore", "");
  canvas.setAttribute("data-hf-ignore", "");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.pointerEvents = "none";
  canvas.style.display = "none";
  element.parentNode?.insertBefore(canvas, element.nextSibling);
  return canvas;
}

export function createColorGradingRuntime(): RuntimeColorGradingApi {
  const entries = new WeakMap<ColorGradingMediaElement, ColorGradingEntry>();
  const trackedElements = new Set<ColorGradingMediaElement>();
  let observer: MutationObserver | null = null;
  let destroyed = false;

  const upsert = (
    element: ColorGradingMediaElement,
    grading: NormalizedHfColorGrading,
    source: EntrySource,
  ): boolean => {
    const existing = entries.get(element);
    if (existing) {
      existing.grading = grading;
      existing.source = source;
      drawEntry(existing);
      if (element instanceof HTMLVideoElement && !element.paused) scheduleVideoDraw(existing);
      return true;
    }
    const canvas = makeCanvas(element);
    const created = createProgramInfo(canvas);
    if (!created) {
      canvas.remove();
      return false;
    }
    const entry: ColorGradingEntry = {
      element,
      canvas,
      gl: created.gl,
      program: created.program,
      grading,
      compare: { ...DEFAULT_COMPARE },
      lut: null,
      lutLoadingSrc: null,
      lutError: null,
      source,
      animationFrame: null,
      videoFrameHandle: null,
      resizeObserver: null,
      cleanup: [],
      touchedParent: null,
      parentInlinePosition: null,
      sourceHidden: false,
      sourceInlineOpacity: null,
      sourceInlineOpacityPriority: "",
      sourceOpacityForCanvas: window.getComputedStyle(element).opacity || "1",
      sourceVisibleForCanvas: window.getComputedStyle(element).visibility !== "hidden",
      hasDrawn: false,
      destroyed: false,
    };
    entries.set(element, entry);
    trackedElements.add(element);
    installEntryListeners(entry);
    drawEntry(entry);
    if (element instanceof HTMLVideoElement && !element.paused) scheduleVideoDraw(entry);
    return true;
  };

  const setCompare = (
    target: HfColorGradingTarget | string | null | undefined,
    rawCompare: unknown,
  ): boolean => {
    if (destroyed) return false;
    const element = resolveTarget(target);
    if (!element) return false;
    let entry = entries.get(element);
    if (!entry) {
      const grading = readColorGradingAttribute(element);
      if (!isHfColorGradingActive(grading) || !upsert(element, grading, "attribute")) return false;
      entry = entries.get(element);
    }
    if (!entry) return false;
    entry.compare = normalizeCompare(rawCompare);
    drawEntry(entry);
    return true;
  };

  const removeElement = (element: ColorGradingMediaElement): void => {
    const entry = entries.get(element);
    if (!entry) return;
    destroyEntry(entry);
    entries.delete(element);
    trackedElements.delete(element);
  };

  const refresh = (): number => {
    if (destroyed) return 0;
    const attributeElements = new Set<ColorGradingMediaElement>();
    const nodes = document.querySelectorAll(
      `video[${HF_COLOR_GRADING_ATTR}], img[${HF_COLOR_GRADING_ATTR}]`,
    );
    nodes.forEach((node) => {
      if (!isColorGradingMediaElement(node)) return;
      attributeElements.add(node);
      const grading = readColorGradingAttribute(node);
      if (isHfColorGradingActive(grading)) {
        upsert(node, grading, "attribute");
      } else {
        removeElement(node);
      }
    });
    for (const element of Array.from(trackedElements)) {
      const entry = entries.get(element);
      if (!entry) continue;
      if (
        !element.isConnected ||
        (entry.source === "attribute" && !attributeElements.has(element))
      ) {
        removeElement(element);
      }
    }
    return trackedElements.size;
  };

  const redraw = (): number => {
    if (destroyed) return 0;
    let drawn = 0;
    for (const entry of Array.from(trackedElements, (element) => entries.get(element))) {
      if (entry && drawEntry(entry)) drawn += 1;
    }
    return drawn;
  };

  const setGrading = (
    target: HfColorGradingTarget | string | null | undefined,
    rawGrading: unknown,
  ): boolean => {
    if (destroyed) return false;
    const element = resolveTarget(target);
    if (!element) return false;
    const grading = normalizeHfColorGrading(rawGrading);
    if (!isHfColorGradingActive(grading)) {
      removeElement(element);
      return true;
    }
    return upsert(element, grading, "live");
  };

  const setSourceVisibility = (target: Element, visible: boolean): boolean => {
    if (!isColorGradingMediaElement(target)) return false;
    const entry = entries.get(target);
    if (!entry) return false;
    entry.sourceVisibleForCanvas = visible;
    return true;
  };

  const getStatus = (
    target: HfColorGradingTarget | string | null | undefined,
  ): RuntimeColorGradingStatus => {
    const element = resolveTarget(target);
    if (!element) return { state: "missing", message: "Media not found" };
    const entry = entries.get(element);
    if (entry) {
      if (entry.lutError) {
        return { state: "unavailable", message: entry.lutError };
      }
      if (entry.grading.lut && entry.lutLoadingSrc) {
        return { state: "pending", message: "Loading LUT" };
      }
      if (entry.canvas.style.display === "none") {
        return { state: "pending", message: "Waiting for media frame" };
      }
      return {
        state: "active",
        message: entry.lut ? "Shader + LUT active" : "Shader active",
      };
    }
    const grading = readColorGradingAttribute(element);
    if (isHfColorGradingActive(grading)) {
      return { state: "unavailable", message: "WebGL unavailable" };
    }
    return { state: "inactive", message: "No grading applied" };
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    observer = null;
    for (const element of Array.from(trackedElements)) removeElement(element);
  };

  if (document.body) {
    observer = new MutationObserver(() => refresh());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [HF_COLOR_GRADING_ATTR],
    });
  }

  const api: RuntimeColorGradingApi = {
    refresh,
    redraw,
    setGrading,
    setCompare,
    setSourceVisibility,
    getStatus,
    destroy,
  };
  const win = window as WindowWithColorGrading;
  win.__hf = win.__hf || {};
  win.__hf.colorGrading = api;
  refresh();
  return api;
}
