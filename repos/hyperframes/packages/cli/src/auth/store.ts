/**
 * Read/write the shared `~/.heygen/credentials` file (JSON contents,
 * no `.json` extension — the path matches heygen-cli).
 *
 * Current format:
 *   {
 *     "api_key": "hg_...",
 *     "oauth": {
 *       "access_token": "...",
 *       "refresh_token": "...",
 *       "expires_at": "2026-06-25T12:00:00Z",
 *       "scope": "openid profile",
 *       "token_type": "Bearer"
 *     }
 *   }
 *
 * Legacy: a single-line plaintext API key (the format heygen-cli has
 * written historically). If `JSON.parse` rejects the file, we treat the
 * trimmed contents as an API key; the next write upgrades to JSON.
 *
 * Writes go to a temp file + rename, 0600 mode, parent dir 0700.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { credentialPath } from "./paths.js";
import { ErrInvalidStore } from "./errors.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  /** ISO-8601 UTC. */
  expires_at?: string;
  scope?: string;
  token_type?: string;
}

export interface Credentials {
  api_key?: string;
  oauth?: OAuthTokens;
}

export type StoreSource = "file_json" | "file_legacy" | "absent";

export interface ReadResult {
  credentials: Credentials;
  source: StoreSource;
}

export async function readStore(path = credentialPath()): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { credentials: {}, source: "absent" };
    }
    throw ErrInvalidStore(`unable to read ${path}: ${(err as Error).message}`);
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { credentials: {}, source: "absent" };

  if (trimmed.startsWith("{")) {
    return { credentials: parseJsonStore(trimmed), source: "file_json" };
  }

  if (looksLikeApiKey(trimmed)) {
    return { credentials: { api_key: trimmed }, source: "file_legacy" };
  }

  throw ErrInvalidStore("file is not JSON and does not look like a plain API key");
}

export async function writeStore(credentials: Credentials, path = credentialPath()): Promise<void> {
  await ensureDir(dirname(path));
  const body = JSON.stringify(serializeCredentials(credentials), null, 2);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${body}\n`, { mode: FILE_MODE, encoding: "utf8" });
  // `mode` on `writeFile` is masked by umask and only applies on file
  // creation — explicit chmod is the only reliable way to land on 0600.
  // `rename` moves the (already-0600) tmp inode over the destination,
  // so the final file carries the tmp's mode; no post-rename chmod
  // needed even when overwriting a looser-permissioned file.
  await fs.chmod(tmp, FILE_MODE);
  await fs.rename(tmp, path);
}

export async function deleteStore(path = credentialPath()): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Remove only the `oauth` block. Used by `auth logout --keep-api-key`. */
export async function clearOAuth(path = credentialPath()): Promise<void> {
  const { credentials, source } = await readStore(path);
  if (source === "absent" || !credentials.oauth) return;
  if (!credentials.api_key) {
    await deleteStore(path);
    return;
  }
  await writeStore({ api_key: credentials.api_key }, path);
}

async function ensureDir(dir: string): Promise<void> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw ErrInvalidStore(`${dir} exists and is not a directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    /* perm-less filesystems are fine */
  }
}

function parseJsonStore(text: string): Credentials {
  const obj = parseJsonObject(text, "credential file root");
  const out: Credentials = {};
  const apiKey = pickRequiredStringOrAbsent(obj, "api_key", "api_key");
  if (apiKey !== undefined) {
    if (!isHeaderSafe(apiKey)) {
      throw ErrInvalidStore("api_key must not contain control characters");
    }
    out.api_key = apiKey;
  }
  if (obj["oauth"] !== undefined && obj["oauth"] !== null) {
    out.oauth = parseOAuth(obj["oauth"]);
  }
  return out;
}

function parseOAuth(raw: unknown): OAuthTokens {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw ErrInvalidStore("oauth must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const accessToken = pickHeaderSafeString(obj, "access_token");
  if (!accessToken) {
    throw ErrInvalidStore("oauth.access_token must be a non-empty string with no control chars");
  }
  const out: OAuthTokens = { access_token: accessToken };
  const refresh = pickHeaderSafeString(obj, "refresh_token");
  if (refresh) out.refresh_token = refresh;
  const exp = pickNonEmptyString(obj, "expires_at");
  if (exp) out.expires_at = exp;
  const scope = pickNonEmptyString(obj, "scope");
  if (scope) out.scope = scope;
  const tokenType = pickNonEmptyString(obj, "token_type");
  if (tokenType) out.token_type = tokenType;
  return out;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw ErrInvalidStore(`invalid JSON: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw ErrInvalidStore(`${label} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function pickNonEmptyString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Like `pickNonEmptyString` but rejects values containing control chars. */
function pickHeaderSafeString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = pickNonEmptyString(obj, key);
  return v !== undefined && isHeaderSafe(v) ? v : undefined;
}

/**
 * Header-safety check for credential strings: reject any string with
 * CR, LF, NUL, or other C0 control characters. Without this, a
 * malicious credentials.json could smuggle extra request headers via
 * `Authorization` / `x-api-key` (RFC 7230 header injection).
 */
export function isHeaderSafe(s: string): boolean {
  // Reject U+0000-U+001F (C0 controls) and U+007F (DEL) — bytes that
  // aren't allowed in HTTP header values. Using charCodeAt avoids
  // embedding control characters in regex source (lint requirement).
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/**
 * Strict variant: returns the string when present and non-empty,
 * `undefined` when the key is absent or null, and throws when the
 * field is present-but-invalid (wrong type or empty string).
 */
function pickRequiredStringOrAbsent(
  obj: Record<string, unknown>,
  key: string,
  errorLabel: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw ErrInvalidStore(`${errorLabel} must be a non-empty string`);
  }
  return v;
}

function serializeCredentials(c: Credentials): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.api_key) out["api_key"] = c.api_key;
  if (c.oauth) {
    const oauth: Record<string, unknown> = { access_token: c.oauth.access_token };
    if (c.oauth.refresh_token) oauth["refresh_token"] = c.oauth.refresh_token;
    if (c.oauth.expires_at) oauth["expires_at"] = c.oauth.expires_at;
    if (c.oauth.scope) oauth["scope"] = c.oauth.scope;
    if (c.oauth.token_type) oauth["token_type"] = c.oauth.token_type;
    out["oauth"] = oauth;
  }
  return out;
}

/**
 * Legacy-plaintext heuristic. HeyGen API keys come in multiple formats
 * (`sk_V2_…`, historic `hg_…`, partner keys, etc.) and the CLI should
 * NOT shape-check them — the backend's `/v3/users/me` is the source of
 * truth and the existing `auth login` rollback handles bad keys cleanly.
 * We only require: a single line, printable, of reasonable length, and
 * header-safe (no CR/LF). JSON files are detected separately by the
 * leading `{`, so this path can't swallow a JSON fragment.
 */
function looksLikeApiKey(s: string): boolean {
  if (s.length < 8) return false;
  if (!isHeaderSafe(s)) return false;
  // Single line of printable ASCII (excluding space, since real keys
  // don't contain spaces — a space-bearing blob is almost certainly
  // not a credential).
  return /^[!-~]+$/.test(s);
}
