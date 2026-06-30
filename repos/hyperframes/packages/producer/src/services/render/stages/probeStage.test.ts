import { describe, expect, it, mock } from "bun:test";
import { hasScriptedAudioVolumeAutomation } from "./probeStage.js";

// ── Mocks for runProbeStage tests ────────────────────────────────────────────
// Capture the cfg passed to createCaptureSession so we can assert it carries
// the correct forceScreenshot value (regression for #1236 — probe was launched
// in beginframe mode even when lowMemoryMode demanded screenshot capture).
const capturedCfgs: unknown[] = [];

const mockPage = {
  evaluate: async () => ({
    timelineKeys: [],
    hfDuration: 5,
    gsapLoaded: false,
    totalDurationMs: 5000,
    __hf: {},
  }),
};

mock.module("@hyperframes/engine", () => ({
  createCaptureSession: async (
    _url: string,
    _dir: string,
    _opts: unknown,
    _nullArg: unknown,
    cfg: unknown,
  ) => {
    capturedCfgs.push(cfg);
    return {
      isInitialized: false,
      browserConsoleBuffer: [],
      page: mockPage,
    };
  },
  initializeSession: async (session: { isInitialized: boolean }) => {
    session.isInitialized = true;
  },
  getCompositionDuration: async () => 5,
  closeCaptureSession: async () => {},
}));

mock.module("../../fileServer.js", () => ({
  createFileServer: async () => ({
    url: "http://127.0.0.1:0",
    port: 0,
    close: () => {},
    addPreHeadScript: () => {},
  }),
  VIRTUAL_TIME_SHIM: "",
}));

mock.module("../../htmlCompiler.js", () => ({
  discoverMediaFromBrowser: async () => [],
  discoverAudioVolumeAutomationFromTimeline: async () => [],
  discoverVideoVisibilityFromTimeline: async () => [],
  recompileWithResolutions: async (c: unknown) => c,
  resolveCompositionDurations: async () => [],
}));

mock.module("../shared.js", () => ({
  BROWSER_MEDIA_EPSILON: 0.0001,
  projectBrowserEndToCompositionTimeline: () => 0,
  writeCompiledArtifacts: () => {},
}));

function makeProbeInput(overrides: {
  cfgForceScreenshot?: boolean;
  stageForceScreenshot?: boolean;
}) {
  const cfg = {
    forceScreenshot: overrides.cfgForceScreenshot ?? false,
    lowMemoryMode: false,
    // Minimal EngineConfig fields consumed by probeStage
    fps: 30,
    quality: "standard",
    format: "jpeg",
    jpegQuality: 80,
    concurrency: "auto",
    coresPerWorker: 2.5,
    minParallelFrames: 120,
    largeRenderThreshold: 1000,
    disableGpu: false,
    browserGpuMode: "software",
    enableBrowserPool: false,
    browserTimeout: 120_000,
    protocolTimeout: 300_000,
    enableChunkedEncode: false,
    chunkSizeFrames: 360,
    enableStreamingEncode: false,
    streamingEncodeMaxDurationSeconds: 240,
    ffmpegEncodeTimeout: 600_000,
    ffmpegProcessTimeout: 300_000,
    ffmpegStreamingTimeout: 600_000,
    hdr: false,
    hdrAutoDetect: true,
    audioGain: 1,
    frameDataUriCacheLimit: 256,
    frameDataUriCacheBytesLimitMb: 1500,
    playerReadyTimeout: 45_000,
    renderReadyTimeout: 15_000,
    verifyRuntime: true,
    debug: false,
  };

  return {
    projectDir: "/tmp/hf-probe-test-project",
    workDir: "/tmp/hf-probe-test-work",
    job: {
      id: "probe-test",
      config: { fps: { num: 30, den: 1 }, quality: "standard" },
      status: "queued",
      progress: 0,
      currentStage: "Probe",
      createdAt: new Date(0),
      duration: 0,
    },
    // composition.duration = 0 forces needsBrowser = true, triggering
    // the createCaptureSession call we want to inspect.
    composition: {
      duration: 0,
      videos: [],
      audios: [],
      images: [],
      width: 1920,
      height: 1080,
    },
    compiled: {
      html: "<html><body><div class='clip' data-duration='5'></div></body></html>",
      subCompositions: new Map(),
      videos: [],
      audios: [],
      images: [],
      unresolvedCompositions: [],
      externalAssets: new Map(),
      width: 1920,
      height: 1080,
      staticDuration: 5,
      renderModeHints: { recommendScreenshot: false, reasons: [] },
      hasShaderTransitions: false,
    },
    cfg,
    // This is the value the orchestrator/planner threads in after the
    // low-memory bump (or any other forceScreenshot override).
    forceScreenshot: overrides.stageForceScreenshot ?? false,
    width: 1920,
    height: 1080,
    needsAlpha: false,
    deviceScaleFactor: 1,
    log: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    },
    assertNotAborted: () => {},
  };
}

describe("hasScriptedAudioVolumeAutomation", () => {
  it("ignores non-script volume text", () => {
    expect(
      hasScriptedAudioVolumeAutomation(
        `<style>.volume-control { opacity: 1; }</style><script>const level = 1;</script>`,
        1,
      ),
    ).toBe(false);
  });

  it("detects direct media volume writes", () => {
    expect(hasScriptedAudioVolumeAutomation(`<script>audio.volume = 0.5;</script>`, 1)).toBe(true);
  });

  it("detects GSAP volume tweens", () => {
    expect(
      hasScriptedAudioVolumeAutomation(`<script>gsap.to(audio, { volume: 1 });</script>`, 1),
    ).toBe(true);
  });

  it("parses script tags with whitespace before the closing bracket", () => {
    expect(hasScriptedAudioVolumeAutomation(`<script>audio.volume = 0.5;</script >`, 1)).toBe(true);
  });

  it("requires audio metadata", () => {
    expect(
      hasScriptedAudioVolumeAutomation(`<script>gsap.to(audio, { volume: 1 });</script>`, 0),
    ).toBe(false);
  });
});

describe("runProbeStage — forceScreenshot threading", () => {
  it("passes forceScreenshot:true to createCaptureSession when stage input carries it but cfg does not (low-memory mode fix #1236)", async () => {
    capturedCfgs.length = 0;

    const { runProbeStage } = await import("./probeStage.js");

    // Simulate renderOrchestrator / plan.ts after the low-memory bump:
    //   cfg.forceScreenshot = false  (compileStage resolved it without the bump)
    //   stage forceScreenshot = true (orchestrator detected lowMemoryMode and bumped)
    const input = makeProbeInput({ cfgForceScreenshot: false, stageForceScreenshot: true });

    await runProbeStage(input);

    expect(capturedCfgs.length).toBeGreaterThan(0);
    const capturedCfg = capturedCfgs[0] as { forceScreenshot: boolean };
    expect(capturedCfg.forceScreenshot).toBe(true);
    // Caller-owned cfg must not be mutated
    expect(input.cfg.forceScreenshot).toBe(false);
  });

  it("passes forceScreenshot:false through unchanged when neither cfg nor stage input forces it", async () => {
    capturedCfgs.length = 0;

    const { runProbeStage } = await import("./probeStage.js");

    const input = makeProbeInput({ cfgForceScreenshot: false, stageForceScreenshot: false });

    await runProbeStage(input);

    expect(capturedCfgs.length).toBeGreaterThan(0);
    const capturedCfg = capturedCfgs[0] as { forceScreenshot: boolean };
    expect(capturedCfg.forceScreenshot).toBe(false);
  });
});
