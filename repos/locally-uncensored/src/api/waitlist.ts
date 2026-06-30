/**
 * Cloud "Hosted LU Workflows" waitlist — opt-in email capture.
 *
 * The ONLY thing LU ever sends off the user's device, and only when the user
 * explicitly clicks "Notify me". No telemetry, no tracking, no ping on launch.
 *
 * In the built app (Tauri) the POST goes through the Rust `waitlist_submit`
 * command (bypasses CORS, keeps the request off the webview origin). In dev
 * (`npm run dev`, plain browser) there is no Rust side, so we hit the Supabase
 * REST endpoint directly — Supabase allows this with the public anon key under
 * an insert-only RLS policy.
 */

import { isTauri } from "./backend";
import { log } from "../lib/logger";

/** LU's own Supabase project (EU region). Public URL — only used on the dev path. */
const SUPABASE_URL = "https://gewbdlmziumhseftxgrr.supabase.co";

/**
 * Public-safe anon key (JWT `role:anon`) — ONLY used on the dev (non-Tauri)
 * path; the built app holds the key in Rust. Safe to ship: under the insert-only
 * RLS policy it can only INSERT into `waitlist`, never read it.
 */
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdld2JkbG16aXVtaHNlZnR4Z3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNDk2MzQsImV4cCI6MjA4ODcyNTYzNH0.aywRbeeJNQezl56i_39dA0EpdsN6Y4AI9EkobSmJQ3A";

export type WaitlistSource = "app-badge" | "readme" | "landing";

/** Same shape the Rust side and the web companion validate against. */
export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

/** Best-effort app version for the `app_version` column (metadata only). */
async function getAppVersion(): Promise<string> {
  try {
    if (isTauri()) {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    }
  } catch {
    /* fall through to the release default */
  }
  return "2.5.0";
}

/**
 * Submit one opt-in email to the waitlist. Throws on invalid email or a failed
 * request; resolves on success (a repeat email is a silent success — the user
 * is simply already on the list).
 */
export async function submitWaitlist(
  email: string,
  source: WaitlistSource = "app-badge",
): Promise<void> {
  const clean = email.trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error("Please enter a valid email address.");

  const version = await getAppVersion();

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // Single-word keys map 1:1 to the Rust params (no camel/snake ambiguity).
    await invoke("waitlist_submit", { email: clean, source, version });
    return;
  }

  // Dev / browser path: direct REST insert.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      // return=minimal is mandatory under insert-only RLS (no SELECT-back).
      // Plain insert (not an upsert — that 401s under insert-only RLS); a
      // duplicate email comes back as 409, handled as success below.
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ email: clean, source, app_version: version }),
  });
  // 409 = duplicate email (unique constraint) → still "on the list".
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => "");
    log.warn("[waitlist] dev submit failed", { status: res.status, text });
    throw new Error(`Waitlist signup failed (HTTP ${res.status}).`);
  }
}
