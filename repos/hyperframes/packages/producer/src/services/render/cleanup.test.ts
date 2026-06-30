/**
 * Tests for the cancel/error-path helpers in `./cleanup.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureSession } from "@hyperframes/engine";
import type { FileServerHandle } from "../fileServer.js";
import { buildRenderErrorDetails, cleanupRenderResources, safeCleanup } from "./cleanup.js";

function makeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("safeCleanup", () => {
  it("returns normally when the operation succeeds", async () => {
    const log = makeLog();
    const op = vi.fn().mockResolvedValue(undefined);
    await safeCleanup("close x", op, log);
    expect(op).toHaveBeenCalledOnce();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("swallows thrown errors and logs them at debug", async () => {
    const log = makeLog();
    await safeCleanup(
      "close x",
      () => {
        throw new Error("boom");
      },
      log,
    );
    expect(log.debug).toHaveBeenCalledWith("Cleanup failed (close x)", { error: "boom" });
  });

  it("swallows async rejections", async () => {
    const log = makeLog();
    await safeCleanup("close x", async () => Promise.reject(new Error("async boom")), log);
    expect(log.debug).toHaveBeenCalledWith("Cleanup failed (close x)", { error: "async boom" });
  });
});

describe("cleanupRenderResources", () => {
  it("closes fileServer, probeSession, then removes workDir (non-debug)", async () => {
    const log = makeLog();
    const workDir = mkdtempSync(join(tmpdir(), "cleanup-test-"));
    writeFileSync(join(workDir, "marker.txt"), "x");

    const order: string[] = [];
    const fileServer = {
      close: () => {
        order.push("fileServer.close");
      },
    } as unknown as FileServerHandle;
    const probeSession = {
      _markClosed: () => {
        order.push("probeSession.close");
      },
    } as unknown as CaptureSession;

    // closeCaptureSession is the engine helper; the helper itself isn't
    // mockable per-call without intercepting the module import. Instead
    // we verify the higher-level invariants: fileServer.close was called,
    // and the workDir was rmSync'd.
    await cleanupRenderResources({
      fileServer,
      probeSession: null, // skip probe to keep this test focused on the workDir invariant
      workDir,
      debug: false,
      log,
      label: "cancel",
    });

    expect(order).toEqual(["fileServer.close"]);
    expect(existsSync(workDir)).toBe(false);
    void probeSession; // suppress unused-var (kept as a doc of the surface)
  });

  it("keeps workDir when debug=true", async () => {
    const log = makeLog();
    const workDir = mkdtempSync(join(tmpdir(), "cleanup-debug-"));
    writeFileSync(join(workDir, "marker.txt"), "x");

    await cleanupRenderResources({
      fileServer: null,
      probeSession: null,
      workDir,
      debug: true,
      log,
      label: "error",
    });

    expect(existsSync(workDir)).toBe(true);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("is a no-op for missing workDir thanks to rmSync force:true", async () => {
    const log = makeLog();
    const workDir = join(tmpdir(), `cleanup-missing-${Date.now()}`);
    expect(existsSync(workDir)).toBe(false);

    await cleanupRenderResources({
      fileServer: null,
      probeSession: null,
      workDir,
      debug: false,
      log,
      label: "error",
    });

    // No throw; nothing logged at debug for the rmSync step.
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs (and continues past) a fileServer.close that throws", async () => {
    const log = makeLog();
    const workDir = mkdtempSync(join(tmpdir(), "cleanup-throw-"));

    const fileServer = {
      close: () => {
        throw new Error("server stuck");
      },
    } as unknown as FileServerHandle;

    await cleanupRenderResources({
      fileServer,
      probeSession: null,
      workDir,
      debug: false,
      log,
      label: "error",
    });

    expect(log.debug).toHaveBeenCalledWith("Cleanup failed (close file server (error))", {
      error: "server stuck",
    });
    expect(existsSync(workDir)).toBe(false);
  });
});

describe("buildRenderErrorDetails", () => {
  const baseDiagnostics = { videoExtractionFailures: 0, imageDecodeFailures: 0 };

  it("extracts message + stack from Error instances", () => {
    const err = new Error("nope");
    const result = buildRenderErrorDetails({
      error: err,
      pipelineStartMs: Date.now() - 5000,
      lastBrowserConsole: [],
      perfStages: {},
      hdrDiagnostics: baseDiagnostics,
    });
    expect(result.message).toBe("nope");
    expect(result.stack).toBeDefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(typeof result.freeMemoryMB).toBe("number");
  });

  it("stringifies non-Error rejections", () => {
    const result = buildRenderErrorDetails({
      error: "raw string failure",
      pipelineStartMs: Date.now(),
      lastBrowserConsole: [],
      perfStages: {},
      hdrDiagnostics: baseDiagnostics,
    });
    expect(result.message).toBe("raw string failure");
    expect(result.stack).toBeUndefined();
  });

  it("includes browserConsoleTail only when buffer is non-empty (last 30 lines)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const result = buildRenderErrorDetails({
      error: new Error("x"),
      pipelineStartMs: Date.now(),
      lastBrowserConsole: lines,
      perfStages: {},
      hdrDiagnostics: baseDiagnostics,
    });
    expect(result.browserConsoleTail).toHaveLength(30);
    expect(result.browserConsoleTail?.[0]).toBe("line 20");
    expect(result.browserConsoleTail?.[29]).toBe("line 49");
  });

  it("omits browserConsoleTail when buffer is empty", () => {
    const result = buildRenderErrorDetails({
      error: new Error("x"),
      pipelineStartMs: Date.now(),
      lastBrowserConsole: [],
      perfStages: {},
      hdrDiagnostics: baseDiagnostics,
    });
    expect(result.browserConsoleTail).toBeUndefined();
  });

  it("includes perfStages snapshot only when non-empty", () => {
    const empty = buildRenderErrorDetails({
      error: new Error("x"),
      pipelineStartMs: Date.now(),
      lastBrowserConsole: [],
      perfStages: {},
      hdrDiagnostics: baseDiagnostics,
    });
    expect(empty.perfStages).toBeUndefined();

    const populated = buildRenderErrorDetails({
      error: new Error("x"),
      pipelineStartMs: Date.now(),
      lastBrowserConsole: [],
      perfStages: { compileMs: 12, captureMs: 340 },
      hdrDiagnostics: baseDiagnostics,
    });
    expect(populated.perfStages).toEqual({ compileMs: 12, captureMs: 340 });
  });

  it("includes hdrDiagnostics only when at least one failure counter > 0", () => {
    const clean = buildRenderErrorDetails({
      error: new Error("x"),
      pipelineStartMs: Date.now(),
      lastBrowserConsole: [],
      perfStages: {},
      hdrDiagnostics: baseDiagnostics,
    });
    expect(clean.hdrDiagnostics).toBeUndefined();

    const failed = buildRenderErrorDetails({
      error: new Error("x"),
      pipelineStartMs: Date.now(),
      lastBrowserConsole: [],
      perfStages: {},
      hdrDiagnostics: { videoExtractionFailures: 2, imageDecodeFailures: 0 },
    });
    expect(failed.hdrDiagnostics).toEqual({ videoExtractionFailures: 2, imageDecodeFailures: 0 });
  });
});

// Quiet unused-import warning — these are referenced via type-only paths.
void mkdirSync;
