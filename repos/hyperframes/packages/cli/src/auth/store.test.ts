import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAuthError } from "./errors.js";
import { clearOAuth, deleteStore, readStore, writeStore, type Credentials } from "./store.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "hf-auth-store-"));
}

// POSIX file modes don't apply on Windows — `fs.chmod` only toggles the
// read-only bit there, so `stat.mode & 0o777` reports 0o666/0o444
// regardless of what we requested. Skip the mode assertions on win32;
// the 0600/0700 hardening is a Unix concern.
const IS_POSIX = process.platform !== "win32";

describe("auth/store", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await makeTmpDir();
    path = join(dir, "credentials");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns absent when the file does not exist", async () => {
    const result = await readStore(path);
    expect(result).toEqual({ credentials: {}, source: "absent" });
  });

  it("round-trips api_key only", async () => {
    const creds: Credentials = { api_key: "hg_test_abc" };
    await writeStore(creds, path);
    const result = await readStore(path);
    expect(result.source).toBe("file_json");
    expect(result.credentials).toEqual(creds);
  });

  it("round-trips oauth tokens", async () => {
    const creds: Credentials = {
      oauth: {
        access_token: "at_123",
        refresh_token: "rt_456",
        expires_at: "2026-06-25T12:00:00.000Z",
        scope: "openid profile",
        token_type: "Bearer",
      },
    };
    await writeStore(creds, path);
    const result = await readStore(path);
    expect(result.credentials).toEqual(creds);
  });

  it("round-trips both api_key and oauth", async () => {
    const creds: Credentials = {
      api_key: "hg_test_abc",
      oauth: { access_token: "at_123" },
    };
    await writeStore(creds, path);
    const result = await readStore(path);
    expect(result.credentials.api_key).toBe("hg_test_abc");
    expect(result.credentials.oauth?.access_token).toBe("at_123");
  });

  it("reads legacy one-line plaintext format", async () => {
    await fs.writeFile(path, "hg_legacy_key\n", { mode: 0o600 });
    const result = await readStore(path);
    expect(result.source).toBe("file_legacy");
    expect(result.credentials.api_key).toBe("hg_legacy_key");
  });

  it("treats empty file as absent", async () => {
    await fs.writeFile(path, "", { mode: 0o600 });
    const result = await readStore(path);
    expect(result.source).toBe("absent");
  });

  it("throws ErrInvalidStore on garbage JSON", async () => {
    await fs.writeFile(path, "{not valid json", { mode: 0o600 });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("throws ErrInvalidStore on multi-line non-JSON content", async () => {
    await fs.writeFile(path, "not\na\nkey", { mode: 0o600 });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it.skipIf(!IS_POSIX)("writes file 0600 and dir 0700", async () => {
    const nested = join(dir, "sub", "deeper");
    const p = join(nested, "credentials");
    await writeStore({ api_key: "hg_x" }, p);
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(nested)).mode & 0o777).toBe(0o700);
  });

  it("preserves content across overwrites", async () => {
    await writeStore({ api_key: "first" }, path);
    await writeStore({ api_key: "second" }, path);
    if (IS_POSIX) {
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    }
    const result = await readStore(path);
    expect(result.credentials.api_key).toBe("second");
  });

  it("rejects empty-string api_key", async () => {
    await fs.writeFile(path, JSON.stringify({ api_key: "" }), { mode: 0o600 });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("rejects api_key with CR/LF (header-injection guard)", async () => {
    await fs.writeFile(path, JSON.stringify({ api_key: "hg_x\r\nX-Evil: foo" }), { mode: 0o600 });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("strips oauth fields containing CR/LF rather than crashing later", async () => {
    await fs.writeFile(
      path,
      JSON.stringify({
        oauth: {
          access_token: "good_at",
          refresh_token: "bad_rt\r\nX-Smuggle: 1",
        },
      }),
      { mode: 0o600 },
    );
    const result = await readStore(path);
    expect(result.credentials.oauth?.access_token).toBe("good_at");
    expect(result.credentials.oauth?.refresh_token).toBeUndefined();
  });

  it("rejects access_token containing CR/LF (header-injection guard)", async () => {
    await fs.writeFile(path, JSON.stringify({ oauth: { access_token: "at\r\nX-Evil: 1" } }), {
      mode: 0o600,
    });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("accepts a legacy plaintext key of any HeyGen key format", async () => {
    // Real HeyGen keys come in multiple formats (`sk_V2_…`, `hg_…`,
    // partner keys, etc.). The CLI doesn't shape-check — the backend
    // does. Any single-line printable non-empty value is accepted as
    // a legacy key here; the next /v3/users/me call decides validity.
    await fs.writeFile(path, "sk_V2_hgu_kVzzCxfI3cT_Yi96MxT2Ki6UamtWxyP7oOIPqsxaFHqN", {
      mode: 0o600,
    });
    const result = await readStore(path);
    expect(result.source).toBe("file_legacy");
    expect(result.credentials.api_key).toBe(
      "sk_V2_hgu_kVzzCxfI3cT_Yi96MxT2Ki6UamtWxyP7oOIPqsxaFHqN",
    );
  });

  it("still rejects plaintext that contains a space (not a credential shape)", async () => {
    await fs.writeFile(path, "hello world this is not a key", { mode: 0o600 });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("still rejects too-short plaintext", async () => {
    await fs.writeFile(path, "tiny", { mode: 0o600 });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("rejects oauth without access_token", async () => {
    await fs.writeFile(path, JSON.stringify({ oauth: { refresh_token: "rt" } }), {
      mode: 0o600,
    });
    await expect(readStore(path)).rejects.toSatisfy((err) => isAuthError(err));
  });

  it("drops unknown top-level keys", async () => {
    await fs.writeFile(path, JSON.stringify({ api_key: "hg_x", future_field: { stuff: 1 } }), {
      mode: 0o600,
    });
    const result = await readStore(path);
    expect(result.credentials).toEqual({ api_key: "hg_x" });
  });

  it("deleteStore is idempotent", async () => {
    await writeStore({ api_key: "hg_x" }, path);
    await deleteStore(path);
    await deleteStore(path);
    await expect(fs.access(path)).rejects.toThrow();
  });

  it("clearOAuth removes only the oauth field", async () => {
    await writeStore({ api_key: "hg_keep", oauth: { access_token: "drop_me" } }, path);
    await clearOAuth(path);
    const result = await readStore(path);
    expect(result.credentials.oauth).toBeUndefined();
    expect(result.credentials.api_key).toBe("hg_keep");
  });

  it("clearOAuth removes the whole file when no api_key remains", async () => {
    await writeStore({ oauth: { access_token: "only" } }, path);
    await clearOAuth(path);
    await expect(fs.access(path)).rejects.toThrow();
  });

  it("clearOAuth is a no-op when file is absent", async () => {
    await clearOAuth(path);
    await expect(fs.access(path)).rejects.toThrow();
  });
});
