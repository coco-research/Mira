import { describe, expect, it } from "vitest";
import {
  clampTimelineZoomPercent,
  getNextTimelineZoomPercent,
  getPinchTimelineZoomPercent,
  getTimelinePixelsPerSecond,
  getTimelineZoomPercent,
  MAX_TIMELINE_ZOOM_PERCENT,
  MIN_TIMELINE_ZOOM_PERCENT,
} from "./timelineZoom";

describe("clampTimelineZoomPercent", () => {
  it("defaults invalid values to 100", () => {
    expect(clampTimelineZoomPercent(Number.NaN)).toBe(100);
  });

  it("clamps to the supported percent bounds", () => {
    expect(clampTimelineZoomPercent(1)).toBe(MIN_TIMELINE_ZOOM_PERCENT);
    expect(clampTimelineZoomPercent(5000)).toBe(MAX_TIMELINE_ZOOM_PERCENT);
  });
});

describe("getTimelineZoomPercent", () => {
  it("treats fit mode as 100 percent", () => {
    expect(getTimelineZoomPercent("fit", 375)).toBe(100);
  });

  it("returns the clamped manual zoom percent", () => {
    expect(getTimelineZoomPercent("manual", 125.2)).toBe(125);
  });
});

describe("getTimelinePixelsPerSecond", () => {
  it("uses fit pixels per second in fit mode", () => {
    expect(getTimelinePixelsPerSecond(144, "fit", 250)).toBe(144);
  });

  it("scales from fit pixels per second in manual mode", () => {
    expect(getTimelinePixelsPerSecond(144, "manual", 125)).toBe(180);
  });
});

describe("getNextTimelineZoomPercent", () => {
  it("zooms out from fit relative to 100 percent", () => {
    expect(getNextTimelineZoomPercent("out", "fit", 375)).toBe(80);
  });

  it("zooms in from fit relative to 100 percent", () => {
    expect(getNextTimelineZoomPercent("in", "fit", 375)).toBe(125);
  });

  it("clamps the lower bound", () => {
    expect(getNextTimelineZoomPercent("out", "manual", MIN_TIMELINE_ZOOM_PERCENT)).toBe(
      MIN_TIMELINE_ZOOM_PERCENT,
    );
  });

  it("clamps the upper bound", () => {
    expect(getNextTimelineZoomPercent("in", "manual", MAX_TIMELINE_ZOOM_PERCENT)).toBe(
      MAX_TIMELINE_ZOOM_PERCENT,
    );
  });
});

describe("getPinchTimelineZoomPercent", () => {
  it("zooms in for upward pinch wheel deltas", () => {
    expect(getPinchTimelineZoomPercent(-80, "fit", 100)).toBeGreaterThan(100);
  });

  it("zooms out for downward pinch wheel deltas", () => {
    expect(getPinchTimelineZoomPercent(80, "manual", 200)).toBeLessThan(200);
  });

  it("keeps the current zoom for zero or invalid deltas", () => {
    expect(getPinchTimelineZoomPercent(0, "manual", 180)).toBe(180);
    expect(getPinchTimelineZoomPercent(Number.NaN, "manual", 180)).toBe(180);
  });

  it("clamps pinch zoom to the supported range", () => {
    expect(getPinchTimelineZoomPercent(10000, "manual", 100)).toBe(MIN_TIMELINE_ZOOM_PERCENT);
    expect(getPinchTimelineZoomPercent(-10000, "manual", 100)).toBe(MAX_TIMELINE_ZOOM_PERCENT);
  });
});
