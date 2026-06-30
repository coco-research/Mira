//! Background shell tasks — Sprint C #7.
//!
//! Spawns a shell command as a detached subprocess and keeps it tracked
//! in a process-wide registry keyed by a UUID. The browser polls
//! `shell_task_status` (or lists everything via `shell_task_list`) and
//! can `shell_task_kill` to cancel. Stdout/stderr are tail-buffered
//! (last 64 KiB each) so a long-running script's tail is always
//! available even after the browser reconnects.
//!
//! Architectural decision: we deliberately do NOT use a Tokio task per
//! waiter. Each spawned child has one reader task that pumps bytes into
//! the tail buffer + updates exit status when the process ends; client
//! requests resolve from that buffer synchronously. This means the
//! browser tab can close and reopen without losing any output.
//!
//! Ported 1:1 from uselu's `apps/bridge/src/commands/bg_tasks.rs` —
//! every body is identical; only the outermost layer is wrapped in
//! `#[tauri::command]` for the desktop IPC bridge.

use crate::commands::{bad_request, internal, not_found, CmdResult};
use crate::state::AppState;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use uuid::Uuid;

// tokio::process::Command has `creation_flags` as an inherent method on
// Windows (since tokio 1.6) so no `CommandExt` trait import is needed.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const TAIL_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct BgTaskStatus {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub running: bool,
    pub cancelled: bool,
    /// Tail of combined stdout+stderr (last ~64 KiB).
    pub output_tail: String,
}

struct BgTaskInner {
    status: BgTaskStatus,
    /// stdout + stderr appended together — order-preserving for the user.
    output_buf: Vec<u8>,
    /// Send `()` to ask the reader task to terminate the child.
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Clone)]
struct BgTask {
    inner: Arc<Mutex<BgTaskInner>>,
}

#[derive(Default)]
struct BgRegistry {
    tasks: Mutex<Vec<BgTask>>,
}

impl BgRegistry {
    fn insert(&self, t: BgTask) {
        let mut g = self.tasks.lock().unwrap();
        // Cap the registry at 200 tasks — drop the oldest *finished* one
        // when we hit the cap so live tasks never get evicted by accident.
        if g.len() >= 200 {
            if let Some(idx) = g
                .iter()
                .position(|t| !t.inner.lock().unwrap().status.running)
            {
                g.remove(idx);
            }
        }
        g.push(t);
    }
    fn get(&self, id: &str) -> Option<BgTask> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.inner.lock().unwrap().status.id == id)
            .cloned()
    }
    fn list(&self) -> Vec<BgTaskStatus> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .map(|t| t.inner.lock().unwrap().status.clone())
            .collect()
    }
}

static REGISTRY: Lazy<BgRegistry> = Lazy::new(BgRegistry::default);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn append_tail(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(bytes);
    if buf.len() > TAIL_BYTES {
        let excess = buf.len() - TAIL_BYTES;
        buf.drain(0..excess);
    }
}

fn render_tail(buf: &[u8]) -> String {
    // Lossy UTF-8 is fine — the browser only needs to *read* the tail.
    String::from_utf8_lossy(buf).to_string()
}

#[derive(Deserialize)]
struct StartArgs {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
}

// ── Internal impls (verbatim from uselu, sans &AppState) ──────────────
// The Tauri-command wrappers below delegate here. Tests bypass the
// State-wrapping layer and call these directly — same as uselu's tests
// did against the originally `pub` fns with a hand-built `AppState`.

async fn shell_task_start_impl(args: &Value) -> CmdResult {
    let a: StartArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    if a.command.trim().is_empty() {
        return Err(bad_request("command is empty"));
    }
    if let Some(cwd) = &a.cwd {
        let p = std::path::Path::new(cwd);
        if !p.is_dir() {
            return Err(bad_request(format!("cwd does not exist: {}", cwd)));
        }
    }

    let id = Uuid::new_v4().to_string();
    let (program, args_vec) = if cfg!(target_os = "windows") {
        let shell = a.shell.unwrap_or_else(|| "powershell".into());
        (
            shell,
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                a.command.clone(),
            ],
        )
    } else {
        let shell = a.shell.unwrap_or_else(|| "bash".into());
        (shell, vec!["-c".into(), a.command.clone()])
    };

    let mut cmd = TokioCommand::new(&program);
    cmd.args(&args_vec);
    if let Some(cwd) = &a.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| internal(format!("spawn {}: {}", program, e)))?;

    // Orphan-safety: tie the child to a kill-on-close Job Object so a true app
    // Quit (tray Quit / parent death) tears these long-running background tasks
    // down too — matching how Ollama/ComfyUI are handled. shutdown_subprocesses
    // (state.rs) only knows the AppState-held PIDs, never this static REGISTRY,
    // so without this a `shell_execute_background` task (e.g. a long build) would
    // be orphaned on Windows after Quit. (v2.5.0 audit fix.)
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.id() {
        crate::commands::process::assign_pid_to_kill_on_close_job(pid);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

    let inner = Arc::new(Mutex::new(BgTaskInner {
        status: BgTaskStatus {
            id: id.clone(),
            command: a.command.clone(),
            cwd: a.cwd.clone(),
            started_at: now_secs(),
            finished_at: None,
            exit_code: None,
            running: true,
            cancelled: false,
            output_tail: String::new(),
        },
        output_buf: Vec::with_capacity(8 * 1024),
        cancel_tx: Some(cancel_tx),
    }));

    REGISTRY.insert(BgTask {
        inner: Arc::clone(&inner),
    });

    let reader_inner = Arc::clone(&inner);
    tokio::spawn(async move {
        // Pump stdout + stderr into the tail buffer concurrently.
        let inner_so = Arc::clone(&reader_inner);
        let inner_se = Arc::clone(&reader_inner);
        let stdout_task = tokio::spawn(async move {
            if let Some(mut s) = stdout {
                let mut tmp = [0u8; 4096];
                loop {
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut g = inner_so.lock().unwrap();
                            append_tail(&mut g.output_buf, &tmp[..n]);
                        }
                    }
                }
            }
        });
        let stderr_task = tokio::spawn(async move {
            if let Some(mut s) = stderr {
                let mut tmp = [0u8; 4096];
                loop {
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut g = inner_se.lock().unwrap();
                            append_tail(&mut g.output_buf, &tmp[..n]);
                        }
                    }
                }
            }
        });

        let wait_result = tokio::select! {
            res = child.wait() => Ok(res),
            _ = cancel_rx => Err(()),
        };
        let (exit_code, cancelled) = match wait_result {
            Ok(Ok(status)) => (status.code(), false),
            Ok(Err(_)) => (None, false),
            Err(_) => {
                let _ = child.kill().await;
                (None, true)
            }
        };
        // Wait for readers to drain so the tail is final.
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let mut g = reader_inner.lock().unwrap();
        g.status.exit_code = exit_code;
        g.status.cancelled = cancelled;
        g.status.running = false;
        g.status.finished_at = Some(now_secs());
        g.status.output_tail = render_tail(&g.output_buf);
        g.cancel_tx = None;
    });

    Ok(json!({ "id": id }))
}

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

async fn shell_task_status_impl(args: &Value) -> CmdResult {
    let a: IdArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let task = REGISTRY
        .get(&a.id)
        .ok_or_else(|| not_found(format!("task not found: {}", a.id)))?;
    let mut g = task.inner.lock().unwrap();
    // Refresh the tail every time so live tasks aren't stuck at start-time.
    g.status.output_tail = render_tail(&g.output_buf);
    Ok(json!(g.status))
}

async fn shell_task_kill_impl(args: &Value) -> CmdResult {
    let a: IdArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let task = REGISTRY
        .get(&a.id)
        .ok_or_else(|| not_found(format!("task not found: {}", a.id)))?;
    let tx = {
        let mut g = task.inner.lock().unwrap();
        g.cancel_tx.take()
    };
    if let Some(tx) = tx {
        let _ = tx.send(());
        Ok(json!({ "ok": true, "cancelled": true }))
    } else {
        Ok(json!({ "ok": true, "cancelled": false, "reason": "already finished" }))
    }
}

async fn shell_task_list_impl(_args: &Value) -> CmdResult {
    let mut tasks = REGISTRY.list();
    // Reverse-chronological — newest first reads better in the UI.
    tasks.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(json!({ "tasks": tasks }))
}

// ── Tauri-callable wrappers ───────────────────────────────────────────

#[tauri::command]
pub async fn shell_task_start(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_start_impl(&args).await
}

#[tauri::command]
pub async fn shell_task_status(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_status_impl(&args).await
}

#[tauri::command]
pub async fn shell_task_kill(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_kill_impl(&args).await
}

#[tauri::command]
pub async fn shell_task_list(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_list_impl(&args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // `echo` works on Linux/macOS; PowerShell's `Write-Output` works on
    // Windows. The spawn path picks the right shell automatically based
    // on `cfg!(target_os = "windows")`.
    fn echo_cmd(msg: &str) -> String {
        if cfg!(target_os = "windows") {
            format!("Write-Output {}", msg)
        } else {
            format!("echo {}", msg)
        }
    }
    fn sleep_cmd_30s() -> &'static str {
        if cfg!(target_os = "windows") {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        }
    }

    #[tokio::test]
    async fn start_runs_a_command_and_status_eventually_reports_finished() {
        let r = shell_task_start_impl(&json!({ "command": echo_cmd("hi") }))
            .await
            .unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        // Poll for completion (test envs vary; cap at 5s).
        for _ in 0..50 {
            let s = shell_task_status_impl(&json!({ "id": id })).await.unwrap();
            if !s["running"].as_bool().unwrap_or(true) {
                assert_eq!(s["exit_code"].as_i64(), Some(0));
                assert!(s["output_tail"].as_str().unwrap_or("").contains("hi"));
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("command never finished");
    }

    #[tokio::test]
    async fn start_rejects_empty_commands() {
        let err = shell_task_start_impl(&json!({ "command": "" })).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn status_returns_404_for_unknown_id() {
        let err = shell_task_status_impl(&json!({ "id": "nonexistent" })).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn kill_cancels_a_running_task() {
        let r = shell_task_start_impl(&json!({ "command": sleep_cmd_30s() }))
            .await
            .unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        // Give the spawn a moment.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = shell_task_kill_impl(&json!({ "id": id.clone() })).await.unwrap();
        for _ in 0..50 {
            let s = shell_task_status_impl(&json!({ "id": id.clone() })).await.unwrap();
            if !s["running"].as_bool().unwrap_or(true) {
                assert!(s["cancelled"].as_bool().unwrap_or(false));
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("kill did not cancel the task");
    }

    #[tokio::test]
    async fn list_returns_active_tasks_newest_first() {
        let r1 = shell_task_start_impl(&json!({ "command": echo_cmd("a") }))
            .await
            .unwrap();
        // Force a deterministic ordering: started_at granularity is 1s so
        // sleep through it before starting the second task.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let r2 = shell_task_start_impl(&json!({ "command": echo_cmd("b") }))
            .await
            .unwrap();
        let id1 = r1["id"].as_str().unwrap().to_string();
        let id2 = r2["id"].as_str().unwrap().to_string();
        let listing = shell_task_list_impl(&json!({})).await.unwrap();
        let tasks = listing["tasks"].as_array().unwrap();
        let ids: Vec<&str> = tasks
            .iter()
            .map(|t| t["id"].as_str().unwrap())
            .collect();
        let pos1 = ids.iter().position(|s| *s == id1).unwrap();
        let pos2 = ids.iter().position(|s| *s == id2).unwrap();
        assert!(pos2 < pos1, "newer task should appear first");
    }
}
