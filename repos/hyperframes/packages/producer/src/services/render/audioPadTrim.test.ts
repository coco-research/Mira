/**
 * Tests for the `audioPadTrim` helper that backs the distributed
 * `assemble()` step's audio duration correction.
 *
 * The helper is split into:
 *   - `buildPadTrimAudioArgs(...)` — pure function, builds the ffmpeg argv
 *     and labels the operation. Fully unit-testable.
 *   - `padOrTrimAudioToVideoFrameCount(...)` — wrapper that probes the
 *     video for frame count + fps, probes the audio for current duration,
 *     and runs ffmpeg with the args from the pure helper. Tests inject
 *     stubs for the probes and the ffmpeg runner.
 *
 * No real ffmpeg/ffprobe runs in these tests.
 */

import { describe, expect, it } from "bun:test";
import {
  buildPadTrimAudioArgs,
  padOrTrimAudioToVideoFrameCount,
  type AudioProbeInfo,
  type PadTrimAudioInput,
  type ProbeVideoFrameInfo,
} from "./audioPadTrim.js";

describe("buildPadTrimAudioArgs", () => {
  it("emits an apad filter when audio is shorter than target", () => {
    const { args, operation } = buildPadTrimAudioArgs("/tmp/in.aac", "/tmp/out.aac", 4.0, 5.0);
    expect(operation).toBe("pad");
    const afIdx = args.indexOf("-af");
    expect(afIdx).toBeGreaterThan(-1);
    expect(args[afIdx + 1]).toContain("apad=pad_dur=");
    expect(args[afIdx + 1]).toMatch(/pad_dur=1\.0+/);
    // Pad must re-encode — apad is a filter and filters can't combine with copy.
    const codecIdx = args.indexOf("-c:a");
    expect(args[codecIdx + 1]).toBe("aac");
    expect(args[args.length - 1]).toBe("/tmp/out.aac");
    expect(args.includes("-y")).toBe(true);
  });

  it("emits -t when audio is longer than target", () => {
    const { args, operation } = buildPadTrimAudioArgs("/tmp/in.aac", "/tmp/out.aac", 6.123, 5.0);
    expect(operation).toBe("trim");
    const tIdx = args.indexOf("-t");
    expect(tIdx).toBeGreaterThan(-1);
    expect(args[tIdx + 1]).toBe("5.000000");
    // Trim preserves AAC stream copy.
    const codecIdx = args.indexOf("-c:a");
    expect(args[codecIdx + 1]).toBe("copy");
  });

  it("emits a plain copy when source duration matches target within ~1ms", () => {
    const { args, operation } = buildPadTrimAudioArgs("/tmp/in.aac", "/tmp/out.aac", 5.0, 5.0);
    expect(operation).toBe("copy");
    expect(args.indexOf("-af")).toBe(-1);
    expect(args.indexOf("-t")).toBe(-1);
    const codecIdx = args.indexOf("-c:a");
    expect(args[codecIdx + 1]).toBe("copy");
  });

  it("emits 6-decimal-place pad_dur (no scientific notation)", () => {
    // 1.23ms — just over the AUDIO_DURATION_TOLERANCE_SECONDS=1ms threshold,
    // so we exercise the pad path with a tiny duration that would round to
    // exponent notation if we used `toString()` instead of `toFixed(6)`.
    const { args, operation } = buildPadTrimAudioArgs("/tmp/in.aac", "/tmp/out.aac", 0.0, 0.00123);
    expect(operation).toBe("pad");
    const afIdx = args.indexOf("-af");
    expect(args[afIdx + 1]).toBe("apad=pad_dur=0.001230");
  });

  it("flags ~1ms drift as a copy (below the tolerance threshold)", () => {
    const close = buildPadTrimAudioArgs("/tmp/a.aac", "/tmp/o.aac", 5.0, 5.0005);
    expect(close.operation).toBe("copy");
  });

  it("flags >1ms drift in either direction as pad/trim", () => {
    const padNeeded = buildPadTrimAudioArgs("/tmp/a.aac", "/tmp/o.aac", 5.0, 5.002);
    expect(padNeeded.operation).toBe("pad");
    const trimNeeded = buildPadTrimAudioArgs("/tmp/a.aac", "/tmp/o.aac", 5.002, 5.0);
    expect(trimNeeded.operation).toBe("trim");
  });
});

describe("padOrTrimAudioToVideoFrameCount", () => {
  // Build a minimal harness that stubs out the three injectables.
  function harness(opts: {
    video: ProbeVideoFrameInfo | "throw";
    audio: AudioProbeInfo | "throw";
    ffmpeg?: (args: string[]) => Promise<{ success: boolean; error?: string }>;
  }): { input: PadTrimAudioInput; captured: { args: string[][] } } {
    const captured = { args: [] as string[][] };
    const input: PadTrimAudioInput = {
      videoPath: "/tmp/v.mp4",
      audioPath: "/tmp/a.aac",
      outputPath: "/tmp/o.aac",
      probeVideoFrameInfo: async () => {
        if (opts.video === "throw") throw new Error("video probe boom");
        return opts.video;
      },
      probeAudioInfo: async () => {
        if (opts.audio === "throw") throw new Error("audio probe boom");
        return opts.audio;
      },
      runFfmpeg:
        opts.ffmpeg ??
        (async (args) => {
          captured.args.push(args);
          return { success: true };
        }),
    };
    return { input, captured };
  }

  it("pads a video of N=180 frames at 30/1 fps with shorter audio", async () => {
    const { input, captured } = harness({
      video: { frameCount: 180, fpsNum: 30, fpsDen: 1 },
      audio: { durationSeconds: 5.5 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(true);
    expect(result.operation).toBe("pad");
    expect(result.targetDurationSeconds).toBe(6);
    expect(result.sourceDurationSeconds).toBe(5.5);
    expect(captured.args).toHaveLength(1);
    const afIdx = captured.args[0]!.indexOf("-af");
    expect(captured.args[0]![afIdx + 1]).toBe("apad=pad_dur=0.500000");
  });

  it("trims a video of N=120 frames at 30/1 fps with longer audio", async () => {
    const { input, captured } = harness({
      video: { frameCount: 120, fpsNum: 30, fpsDen: 1 },
      audio: { durationSeconds: 4.5 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(true);
    expect(result.operation).toBe("trim");
    expect(result.targetDurationSeconds).toBe(4);
    expect(captured.args).toHaveLength(1);
    const tIdx = captured.args[0]!.indexOf("-t");
    expect(captured.args[0]![tIdx + 1]).toBe("4.000000");
  });

  it("emits a copy when audio duration already equals frameCount/fps", async () => {
    const { input, captured } = harness({
      video: { frameCount: 90, fpsNum: 30, fpsDen: 1 },
      audio: { durationSeconds: 3.0 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(true);
    expect(result.operation).toBe("copy");
    expect(result.targetDurationSeconds).toBe(3);
    expect(captured.args[0]!.includes("-af")).toBe(false);
    expect(captured.args[0]!.includes("-t")).toBe(false);
  });

  it("handles NTSC fps (30000/1001) exactly", async () => {
    // 120 frames at 30000/1001 ≈ 4.004s. Audio 4.0s → pad 0.004s.
    const { input, captured } = harness({
      video: { frameCount: 120, fpsNum: 30000, fpsDen: 1001 },
      audio: { durationSeconds: 4.0 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(true);
    expect(result.operation).toBe("pad");
    expect(result.targetDurationSeconds).toBeCloseTo((120 * 1001) / 30000, 9);
    const afIdx = captured.args[0]!.indexOf("-af");
    expect(captured.args[0]![afIdx + 1]).toMatch(/^apad=pad_dur=0\.004\d+$/);
  });

  it("propagates video probe failure as success=false", async () => {
    const { input } = harness({
      video: "throw",
      audio: { durationSeconds: 4.0 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("failed to probe video");
    expect(result.error).toContain("video probe boom");
  });

  it("propagates audio probe failure as success=false", async () => {
    const { input } = harness({
      video: { frameCount: 90, fpsNum: 30, fpsDen: 1 },
      audio: "throw",
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("failed to probe audio");
    expect(result.error).toContain("audio probe boom");
  });

  it("propagates invalid video info (frameCount=0) as success=false", async () => {
    const { input } = harness({
      video: { frameCount: 0, fpsNum: 30, fpsDen: 1 },
      audio: { durationSeconds: 4.0 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid video frame info");
  });

  it("propagates invalid video info (fpsDen=0)", async () => {
    const { input } = harness({
      video: { frameCount: 100, fpsNum: 30, fpsDen: 0 },
      audio: { durationSeconds: 4.0 },
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid video frame info");
  });

  it("propagates ffmpeg failure as success=false with the ffmpeg error preserved", async () => {
    const { input } = harness({
      video: { frameCount: 180, fpsNum: 30, fpsDen: 1 },
      audio: { durationSeconds: 5.0 },
      ffmpeg: async () => ({ success: false, error: "synthetic ffmpeg failure" }),
    });
    const result = await padOrTrimAudioToVideoFrameCount(input);
    expect(result.success).toBe(false);
    expect(result.error).toBe("synthetic ffmpeg failure");
    expect(result.operation).toBe("pad");
    expect(result.targetDurationSeconds).toBe(6);
  });
});
