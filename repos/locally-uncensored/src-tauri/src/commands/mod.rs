pub mod agent;
pub mod bg_tasks;
pub mod repo_map;
pub mod claude_code;
pub mod download;
pub mod filesystem;
pub mod gpu;
pub mod health;
pub mod install;
pub mod process;
pub mod proxy;
pub mod remote;
pub mod search;
pub mod shell;
pub mod system;
pub mod tts;
pub mod waitlist;
pub mod whisper;

// ── uselu-compat error helpers ────────────────────────────────────────
//
// uselu's bridge daemon (axum) uses `internal(msg)` / `bad_request(msg)` /
// `not_found(msg)` helpers that return a structured (StatusCode, Json)
// tuple. The desktop Tauri command convention is `Result<Value, String>`
// where every error collapses to a plain String — Tauri's IPC bridge
// turns it into a JS-side rejection. Re-export the same three names as
// no-op `Into<String>` helpers so files ported verbatim from uselu
// compile without rewriting every `bad_request(...)` call site.
pub type CmdResult = Result<serde_json::Value, String>;

#[allow(dead_code)]
pub fn internal(msg: impl Into<String>) -> String { msg.into() }
#[allow(dead_code)]
pub fn bad_request(msg: impl Into<String>) -> String { msg.into() }
#[allow(dead_code)]
pub fn not_found(msg: impl Into<String>) -> String { msg.into() }
