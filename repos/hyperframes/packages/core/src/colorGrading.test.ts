import { describe, expect, it } from "vitest";
import {
  HF_COLOR_GRADING_COLOR_SPACE,
  isHfColorGradingActive,
  normalizeHfColorGrading,
  normalizeHfColorGradingWithVariables,
  serializeHfColorGrading,
} from "./colorGrading";

describe("color grading", () => {
  it("parses preset shorthand", () => {
    const grading = normalizeHfColorGrading("warm-clean");
    expect(grading?.preset).toBe("warm-clean");
    expect(grading?.colorSpace).toBe(HF_COLOR_GRADING_COLOR_SPACE);
    expect(grading?.adjust.temperature).toBeGreaterThan(0);
    expect(isHfColorGradingActive(grading)).toBe(true);
  });

  it("merges manual adjustments over preset values", () => {
    const grading = normalizeHfColorGrading({
      preset: "warm-clean",
      intensity: 0.5,
      adjust: { temperature: -0.25, contrast: 0.2 },
    });
    expect(grading?.intensity).toBe(0.5);
    expect(grading?.adjust.temperature).toBe(-0.25);
    expect(grading?.adjust.contrast).toBe(0.2);
    expect(grading?.adjust.saturation).toBeGreaterThan(0);
  });

  it("clamps values to supported shader ranges", () => {
    const grading = normalizeHfColorGrading({
      intensity: 2,
      adjust: { exposure: 10, contrast: -5, saturation: 3 },
      lut: { src: "looks/test.cube", intensity: 3 },
    });
    expect(grading?.intensity).toBe(1);
    expect(grading?.adjust.exposure).toBe(2);
    expect(grading?.adjust.contrast).toBe(-1);
    expect(grading?.adjust.saturation).toBe(1);
    expect(grading?.lut?.intensity).toBe(1);
  });

  it("returns null for disabled or invalid grading", () => {
    expect(normalizeHfColorGrading({ enabled: false, preset: "warm-clean" })).toBeNull();
    expect(normalizeHfColorGrading("{nope")).toBeNull();
    expect(normalizeHfColorGrading("")).toBeNull();
  });

  it("serializes normalized grading for data-color-grading", () => {
    const grading = normalizeHfColorGrading({ adjust: { exposure: 0.25 } });
    const serialized = serializeHfColorGrading(grading);
    expect(serialized).toContain('"exposure":0.25');
    expect(normalizeHfColorGrading(serialized)?.adjust.exposure).toBe(0.25);
  });

  it("treats zero global intensity as inactive even with LUT data", () => {
    const grading = normalizeHfColorGrading({
      intensity: 0,
      adjust: { exposure: 0.5 },
      lut: { src: "assets/luts/test.cube", intensity: 1 },
    });
    expect(isHfColorGradingActive(grading)).toBe(false);
  });

  it("resolves exact variable references inside color grading JSON", () => {
    const grading = normalizeHfColorGradingWithVariables(
      JSON.stringify({
        preset: "$preset",
        intensity: "$gradingIntensity",
        adjust: {
          exposure: "${exposure}",
          saturation: "$saturation",
        },
        lut: {
          src: "$lutSrc",
          intensity: "$lutIntensity",
        },
      }),
      {
        preset: "warm-clean",
        gradingIntensity: 0.6,
        exposure: 0.25,
        saturation: -0.2,
        lutSrc: "assets/luts/warm.cube",
        lutIntensity: 0.4,
      },
    );

    expect(grading?.preset).toBe("warm-clean");
    expect(grading?.intensity).toBe(0.6);
    expect(grading?.adjust.exposure).toBe(0.25);
    expect(grading?.adjust.saturation).toBe(-0.2);
    expect(grading?.lut).toEqual({ src: "assets/luts/warm.cube", intensity: 0.4 });
  });

  it("supports a whole grading supplied by one variable", () => {
    const grading = normalizeHfColorGradingWithVariables("$colorGrade", {
      colorGrade: {
        adjust: { contrast: 0.2 },
        lut: { src: "assets/luts/natural-boost.cube", intensity: 0.75 },
      },
    });

    expect(grading?.adjust.contrast).toBe(0.2);
    expect(grading?.lut).toEqual({ src: "assets/luts/natural-boost.cube", intensity: 0.75 });
  });
});
