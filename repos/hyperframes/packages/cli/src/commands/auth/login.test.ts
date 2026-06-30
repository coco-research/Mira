import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStore, writeStore } from "../../auth/store.js";

// Mock only AuthClient — keep the real store/resolver so the test
// exercises the actual on-disk rollback behavior. `verifyResult`
// controls what `getCurrentUser` does per test.
const verifyState = vi.hoisted(() => ({ reject: false }));

vi.mock("../../auth/index.js", async (orig) => {
  const actual = await orig<typeof import("../../auth/index.js")>();
  class MockAuthClient {
    async getCurrentUser(): Promise<{ email: string }> {
      if (verifyState.reject) {
        const { ErrUnauthenticated: rej } = await import("../../auth/errors.js");
        throw rej("invalid key");
      }
      return { email: "alice@example.com" };
    }
  }
  return { ...actual, AuthClient: MockAuthClient };
});

const ENV_KEYS = ["HEYGEN_API_KEY", "HYPERFRAMES_API_KEY", "HEYGEN_CONFIG_DIR"] as const;

describe("auth login --api-key rollback", () => {
  let dir: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "hf-login-"));
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env["HEYGEN_CONFIG_DIR"] = dir;
    verifyState.reject = false;
    // process.exit throws so we can assert the post-rollback state.
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function runLogin(apiKey: string): Promise<void> {
    const cmd = (await import("./login.js")).default;
    // citty command run only reads `args` here.
    await (cmd.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
      args: { "api-key": apiKey },
    });
  }

  it("removes the rejected key on a failed FIRST login (no prior credential)", async () => {
    verifyState.reject = true;
    await expect(runLogin("hg_badkey123")).rejects.toThrow(/process\.exit:1/);

    // The store must NOT retain the rejected key — otherwise the next
    // command would silently resolve a known-bad credential.
    const { source } = await readStore();
    expect(source).toBe("absent");
  });

  it("restores the previous credential on a failed re-login", async () => {
    await writeStore({ api_key: "hg_previous_good" });
    verifyState.reject = true;
    await expect(runLogin("hg_newbadkey99")).rejects.toThrow(/process\.exit:1/);

    const { credentials } = await readStore();
    expect(credentials.api_key).toBe("hg_previous_good");
  });

  it("persists the key on a successful login", async () => {
    verifyState.reject = false;
    await runLogin("hg_goodkey456");
    const { credentials } = await readStore();
    expect(credentials.api_key).toBe("hg_goodkey456");
  });
});
