export const HF_COLOR_GRADING_ATTR = "data-color-grading";

export const HF_COLOR_GRADING_COLOR_SPACE = "rec709";

export type HfColorGradingPresetId =
  | "neutral"
  | "warm-clean"
  | "cool-clean"
  | "soft-boost"
  | "bright-pop"
  | "deep-contrast";

export type HfColorGradingAdjustKey =
  | "exposure"
  | "contrast"
  | "highlights"
  | "shadows"
  | "whites"
  | "blacks"
  | "temperature"
  | "tint"
  | "saturation";

export type HfColorGradingAdjust = Partial<Record<HfColorGradingAdjustKey, number>>;

export interface HfColorGradingLutRef {
  src: string;
  intensity?: number;
}

export interface HfColorGrading {
  enabled?: boolean;
  preset?: HfColorGradingPresetId | string | null;
  intensity?: number;
  adjust?: HfColorGradingAdjust;
  lut?: HfColorGradingLutRef | string | null;
  colorSpace?: typeof HF_COLOR_GRADING_COLOR_SPACE | string;
}

export interface NormalizedHfColorGrading {
  enabled: boolean;
  preset: HfColorGradingPresetId | string | null;
  intensity: number;
  adjust: Record<HfColorGradingAdjustKey, number>;
  lut: HfColorGradingLutRef | null;
  colorSpace: typeof HF_COLOR_GRADING_COLOR_SPACE | string;
}

export interface HfColorGradingTarget {
  id?: string | null;
  hfId?: string | null;
  selector?: string | null;
  selectorIndex?: number | null;
}

export interface HfColorGradingPreset {
  id: HfColorGradingPresetId;
  label: string;
  adjust: Record<HfColorGradingAdjustKey, number>;
}

export type HfColorGradingVariableMap = Record<string, unknown>;

const ADJUST_ZERO: Record<HfColorGradingAdjustKey, number> = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
};

export const HF_COLOR_GRADING_ADJUST_KEYS: readonly HfColorGradingAdjustKey[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "saturation",
];

export const HF_COLOR_GRADING_PRESETS: readonly HfColorGradingPreset[] = [
  {
    id: "neutral",
    label: "Neutral",
    adjust: { ...ADJUST_ZERO },
  },
  {
    id: "warm-clean",
    label: "Warm Clean",
    adjust: {
      ...ADJUST_ZERO,
      exposure: 0.05,
      contrast: 0.08,
      highlights: -0.08,
      shadows: 0.08,
      temperature: 0.16,
      saturation: 0.06,
    },
  },
  {
    id: "cool-clean",
    label: "Cool Clean",
    adjust: {
      ...ADJUST_ZERO,
      contrast: 0.06,
      highlights: -0.06,
      shadows: 0.06,
      temperature: -0.12,
      tint: 0.04,
      saturation: 0.04,
    },
  },
  {
    id: "soft-boost",
    label: "Soft Boost",
    adjust: {
      ...ADJUST_ZERO,
      exposure: 0.06,
      contrast: -0.04,
      highlights: -0.14,
      shadows: 0.16,
      saturation: 0.1,
    },
  },
  {
    id: "bright-pop",
    label: "Bright Pop",
    adjust: {
      ...ADJUST_ZERO,
      exposure: 0.12,
      contrast: 0.12,
      whites: 0.08,
      blacks: -0.04,
      saturation: 0.14,
    },
  },
  {
    id: "deep-contrast",
    label: "Deep Contrast",
    adjust: {
      ...ADJUST_ZERO,
      exposure: -0.03,
      contrast: 0.2,
      highlights: -0.08,
      shadows: -0.08,
      blacks: -0.12,
      saturation: 0.06,
    },
  },
];

const PRESETS_BY_ID = new Map<string, HfColorGradingPreset>(
  HF_COLOR_GRADING_PRESETS.map((preset) => [preset.id, preset]),
);

const VARIABLE_REF_RE = /^\$(?:\{([A-Za-z0-9_.:-]+)\}|([A-Za-z0-9_.:-]+))$/;

const ADJUST_LIMITS: Record<HfColorGradingAdjustKey, { min: number; max: number }> = {
  exposure: { min: -2, max: 2 },
  contrast: { min: -1, max: 1 },
  highlights: { min: -1, max: 1 },
  shadows: { min: -1, max: 1 },
  whites: { min: -1, max: 1 },
  blacks: { min: -1, max: 1 },
  temperature: { min: -1, max: 1 },
  tint: { min: -1, max: 1 },
  saturation: { min: -1, max: 1 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

function clampUnit(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function readAdjustValue(value: unknown, key: HfColorGradingAdjustKey): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const limit = ADJUST_LIMITS[key];
  return clamp(parsed, limit.min, limit.max);
}

function normalizePresetId(value: unknown): HfColorGradingPresetId | string | null {
  if (value == null) return null;
  const preset = String(value).trim();
  return preset ? preset : null;
}

function normalizeLut(value: unknown): HfColorGradingLutRef | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const src = value.trim();
    return src ? { src, intensity: 1 } : null;
  }
  if (!isRecord(value)) return null;
  const rawSrc = value.src;
  if (typeof rawSrc !== "string" || rawSrc.trim() === "") return null;
  return {
    src: rawSrc.trim(),
    intensity: clampUnit(value.intensity, 1),
  };
}

function readColorGradingObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return { preset: trimmed, intensity: 1 };
  }
  return isRecord(raw) ? raw : null;
}

function resolveStringVariableRef(value: string, variables: HfColorGradingVariableMap): unknown {
  const match = value.trim().match(VARIABLE_REF_RE);
  if (!match) return value;
  const key = match[1] ?? match[2] ?? "";
  return key && Object.hasOwn(variables, key) ? variables[key] : value;
}

export function resolveHfColorGradingVariables(
  raw: unknown,
  variables: HfColorGradingVariableMap,
): unknown {
  if (typeof raw === "string") {
    const direct = resolveStringVariableRef(raw, variables);
    if (direct !== raw) return direct;
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return raw;
    try {
      return resolveHfColorGradingVariables(JSON.parse(trimmed) as unknown, variables);
    } catch {
      return raw;
    }
  }
  if (!isRecord(raw)) return raw;

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    resolved[key] = resolveHfColorGradingVariables(value, variables);
  }
  return resolved;
}

function getHfColorGradingPreset(id: string | null | undefined): HfColorGradingPreset | null {
  if (!id) return null;
  return PRESETS_BY_ID.get(id) ?? null;
}

export function normalizeHfColorGrading(raw: unknown): NormalizedHfColorGrading | null {
  const grading = readColorGradingObject(raw);
  if (!grading) return null;
  if (grading.enabled === false) return null;

  const presetId = normalizePresetId(grading.preset);
  const preset = getHfColorGradingPreset(presetId);
  const presetAdjust = preset?.adjust ?? ADJUST_ZERO;
  const rawAdjust = isRecord(grading.adjust) ? grading.adjust : {};
  const adjust = HF_COLOR_GRADING_ADJUST_KEYS.reduce<Record<HfColorGradingAdjustKey, number>>(
    (result, key) => {
      result[key] = readAdjustValue(rawAdjust[key] ?? presetAdjust[key], key);
      return result;
    },
    { ...ADJUST_ZERO },
  );

  return {
    enabled: true,
    preset: presetId,
    intensity: clampUnit(grading.intensity, 1),
    adjust,
    lut: normalizeLut(grading.lut),
    colorSpace:
      typeof grading.colorSpace === "string" && grading.colorSpace.trim()
        ? grading.colorSpace.trim()
        : HF_COLOR_GRADING_COLOR_SPACE,
  };
}

export function normalizeHfColorGradingWithVariables(
  raw: unknown,
  variables: HfColorGradingVariableMap,
): NormalizedHfColorGrading | null {
  return normalizeHfColorGrading(resolveHfColorGradingVariables(raw, variables));
}

export function serializeHfColorGrading(
  grading: NormalizedHfColorGrading | HfColorGrading | null,
): string {
  const normalized = normalizeHfColorGrading(grading);
  if (!normalized) return "";
  const { enabled: _enabled, ...serializable } = normalized;
  return JSON.stringify(serializable);
}

export function isHfColorGradingActive(
  grading: NormalizedHfColorGrading | null,
): grading is NormalizedHfColorGrading {
  if (!grading?.enabled) return false;
  if (grading.intensity === 0) return false;
  if (grading.lut && grading.lut.intensity !== 0) return true;
  return HF_COLOR_GRADING_ADJUST_KEYS.some((key) => Math.abs(grading.adjust[key]) > 0.0001);
}
