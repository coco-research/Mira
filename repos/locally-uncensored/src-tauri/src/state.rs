use std::collections::{HashMap, HashSet};
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::commands::gpu::GpuSelection;
use crate::commands::whisper::WhisperServer;
use crate::commands::remote::RemoteServer;
use crate::python::get_python_bin;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DownloadProgress {
    pub progress: u64,
    pub total: u64,
    pub speed: f64,
    pub filename: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct InstallState {
    pub status: String,
    pub logs: Vec<String>,
    pub download_progress: u64,
    pub download_total: u64,
    pub download_speed: f64,
}

impl Default for InstallState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            logs: Vec::new(),
            download_progress: 0,
            download_total: 0,
            download_speed: 0.0,
        }
    }
}

/// Read persisted ComfyUI port + host from %APPDATA%/locally-uncensored/config.json.
/// Returns (port, host) with sensible defaults (8188, "localhost") on any error.
/// Called at startup so user-configured values survive app restarts.
pub(crate) fn load_comfy_config_values() -> (u16, String) {
    let mut port = 8188u16;
    let mut host = "localhost".to_string();

    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if let Ok(raw) = std::fs::read_to_string(&config_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = v.get("comfyui_port").and_then(|x| x.as_u64()) {
                    if p > 0 && p < 65536 {
                        port = p as u16;
                    }
                }
                if let Some(h) = v.get("comfyui_host").and_then(|x| x.as_str()) {
                    let trimmed = h.trim();
                    if !trimmed.is_empty() {
                        host = trimmed.to_string();
                    }
                }
            }
        }
    }

    (port, host)
}

/// Read persisted Ollama base URL with the following priority:
///  1. `ollama_base` in config.json (GUI-configured)
///  2. `OLLAMA_HOST` env var (Ollama's own convention)
///  3. Default `http://localhost:11434`
///
/// Accepts bare `host:port`, scheme-less `host`, or full URL — returns full
/// URL without trailing slash. Matches Ollama's own OLLAMA_HOST semantics so
/// setting it as an env var before launching LU "just works".
pub(crate) fn load_ollama_base() -> String {
    let normalize = |raw: &str| -> String {
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            "http://localhost:11434".to_string()
        } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else {
            format!("http://{}", trimmed)
        }
    };

    // Priority 1: config.json override (GUI takes precedence)
    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if let Ok(raw) = std::fs::read_to_string(&config_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(b) = v.get("ollama_base").and_then(|x| x.as_str()) {
                    let normalized = normalize(b);
                    if !normalized.is_empty() {
                        return normalized;
                    }
                }
            }
        }
    }

    // Priority 2: OLLAMA_HOST env var — same semantics as Ollama itself.
    // Ollama docs explicitly document e.g. `OLLAMA_HOST=0.0.0.0:11434`.
    if let Ok(env) = std::env::var("OLLAMA_HOST") {
        let normalized = normalize(&env);
        if !normalized.is_empty() {
            return normalized;
        }
    }

    // Priority 3: default
    "http://localhost:11434".to_string()
}

pub struct AppState {
    pub comfy_process: Mutex<Option<Child>>,
    /// Child handle for an Ollama daemon LU spawned itself (kj103x bug, Discord
    /// 2026-05-23 #help-chat). The Drop impl below kills the tree on shutdown
    /// so `ollama.exe` doesn't linger eating ~200 MB after the tray quit.
    /// IMPORTANT: only populated when `start_ollama` / `auto_start_ollama`
    /// actually spawned — if a user-managed `ollama serve` was already
    /// running on the box (detected via tasklist before spawn), we leave it
    /// alone, so closing LU never kills someone else's Ollama.
    pub ollama_process: Mutex<Option<Child>>,
    pub comfy_path: Mutex<Option<String>>,
    pub comfy_port: Mutex<u16>,
    /// Configurable ComfyUI host. Default "localhost". Setting this to a
    /// remote hostname/IP lets users point LU at a ComfyUI running on
    /// another machine (homelab, Docker, LAN). Persisted in config.json.
    pub comfy_host: Mutex<String>,
    /// Configurable Ollama base URL. Default `http://localhost:11434`.
    /// Seeded from (in priority order): config.json `ollama_base` field,
    /// `OLLAMA_HOST` env var, or the default. Updated at runtime via the
    /// `set_ollama_host` command. Every call that proxies Ollama reads this
    /// value so GUI changes reflect everywhere without a restart.
    pub ollama_base: Mutex<String>,
    /// Hosts of user-configured OpenAI-compatible backends reachable over the
    /// LAN (LM Studio / vLLM / etc. bound to 0.0.0.0 on another machine).
    /// Registered at runtime via `register_openai_host` so `validate_proxy_url`
    /// forwards to them — same allow-list model as `ollama_base`/`comfy_host`.
    /// In-memory only; rebuilt lazily from the persisted provider config the
    /// first time a LAN endpoint is used after launch (Bug A / GH #49).
    pub openai_hosts: Mutex<HashSet<String>>,
    pub whisper: Arc<Mutex<WhisperServer>>,
    pub downloads: Arc<Mutex<HashMap<String, DownloadProgress>>>,
    pub download_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub pull_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// Per-stream cancellation tokens for `proxy_localhost_stream_chunked`.
    /// When the user hits Stop or deletes/closes a chat, the JS side calls
    /// `cancel_proxy_stream(stream_id)` → the token fires → the upstream reqwest
    /// stream is dropped → Ollama actually stops generating (David 2026-06-15:
    /// "Aktivität komplett stoppen"; aborting only stopped the JS loop before).
    pub stream_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub install_status: Arc<Mutex<InstallState>>,
    /// Cancel flag for the ComfyUI installer (Bug #1, techx69 v2.4.3).
    /// `install_comfyui` polls this between steps; setting it from
    /// `cancel_comfyui_install` aborts the next git/pip subprocess and
    /// flips the install_status to "cancelled".
    pub comfyui_install_cancel: Arc<AtomicBool>,
    pub ollama_install: Arc<Mutex<InstallState>>,
    pub lmstudio_install: Arc<Mutex<InstallState>>,
    pub python_install: Arc<Mutex<InstallState>>,
    /// §24.9 — progress/log state for the in-app faster-whisper installer
    /// (the STT badge had no way to fix a ✗). Mirrors the other per-installer
    /// states; `install_whisper` writes it, `install_whisper_status` reads it.
    pub whisper_install: Arc<Mutex<InstallState>>,
    /// Progress/log state for the in-app Piper neural-TTS installer (mirrors
    /// `whisper_install`); `install_tts` writes it, `install_tts_status` reads it.
    pub tts_install: Arc<Mutex<InstallState>>,
    pub searxng_install: Mutex<InstallState>,
    pub searxng_available: AtomicBool,
    /// Resolved Python binary path. Empty string means "no real Python on
    /// this box" — callers must treat `""` as the missing-Python sentinel
    /// and surface the install_python flow rather than spawning `"python"`
    /// (which on Windows hits the Microsoft Store stub). Wrapped in a
    /// `Mutex` so `install_python` can update it at runtime once Python
    /// finishes installing — without that, the user would have to restart
    /// LU to pick up the freshly installed Python.
    pub python_bin: Arc<Mutex<String>>,
    // Claude Code
    pub claude_code_process: Mutex<Option<Child>>,
    pub claude_code_install: Arc<Mutex<InstallState>>,
    // Remote Access
    pub remote: Mutex<RemoteServer>,
    /// Per-chat workspace overrides — when present, agent file ops with
    /// a relative path resolve against this folder instead of the
    /// default `~/agent-workspace/<chat_id>/`. Set when the user picks
    /// a folder during Remote dispatch (#29 follow-up); cleared on
    /// undispatch / chat delete.
    pub chat_workspace_overrides: Arc<Mutex<HashMap<String, std::path::PathBuf>>>,
    /// Bug BB v2.5.0 — BobbyT Discord 2026-05-26. User-pinned GPU vendor +
    /// indices, forwarded as CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES /
    /// ONEAPI_DEVICE_SELECTOR on next start_ollama / start_comfyui spawn.
    /// Default "auto" + empty indices = no env-var, runtime picks default
    /// (pre-v2.5.0 behaviour).
    pub gpu_selection: Mutex<GpuSelection>,
    /// flash-attn probe results, keyed by python path (David 2026-06-11:
    /// measured 4-5x faster WAN video sampling vs pytorch SDPA on a 3060).
    /// The probe imports torch (~5-10 s), so only the first ComfyUI start /
    /// Create-tab check per python pays it.
    pub flash_attn_cache: Mutex<HashMap<String, bool>>,
}

impl AppState {
    pub fn new() -> Self {
        let python_bin = get_python_bin();
        if python_bin.is_empty() {
            println!("[Python] Resolved: <none — install_python required for ComfyUI / agent code-exec>");
        } else {
            println!("[Python] Resolved: {}", python_bin);
        }

        // Load persisted ComfyUI port+host from config.json if available.
        // Fixes a pre-existing bug where `set_comfyui_port` wrote to disk but
        // startup never read it back. Same loader now handles the new host field.
        let (initial_port, initial_host) = load_comfy_config_values();
        if initial_port != 8188 {
            println!("[ComfyUI] Loaded persisted port: {}", initial_port);
        }
        if initial_host != "localhost" {
            println!("[ComfyUI] Loaded persisted host: {}", initial_host);
        }

        // Same bootstrap for Ollama — reads config.json first, then
        // OLLAMA_HOST env var, then defaults. Fixes Issue #31 where users
        // with OLLAMA_HOST set globally (Docker, homelab, LAN) saw "No local
        // backend detected" even though ollama.exe was running.
        let initial_ollama_base = load_ollama_base();
        if initial_ollama_base != "http://localhost:11434" {
            println!("[Ollama] Using base URL: {}", initial_ollama_base);
        }

        Self {
            comfy_process: Mutex::new(None),
            ollama_process: Mutex::new(None),
            comfy_path: Mutex::new(None),
            comfy_port: Mutex::new(initial_port),
            comfy_host: Mutex::new(initial_host),
            ollama_base: Mutex::new(initial_ollama_base),
            openai_hosts: Mutex::new(HashSet::new()),
            whisper: Arc::new(Mutex::new(WhisperServer::new())),
            downloads: Arc::new(Mutex::new(HashMap::new())),
            download_tokens: Arc::new(Mutex::new(HashMap::new())),
            pull_tokens: Arc::new(Mutex::new(HashMap::new())),
            stream_tokens: Arc::new(Mutex::new(HashMap::new())),
            install_status: Arc::new(Mutex::new(InstallState::default())),
            comfyui_install_cancel: Arc::new(AtomicBool::new(false)),
            ollama_install: Arc::new(Mutex::new(InstallState::default())),
            lmstudio_install: Arc::new(Mutex::new(InstallState::default())),
            python_install: Arc::new(Mutex::new(InstallState::default())),
            whisper_install: Arc::new(Mutex::new(InstallState::default())),
            tts_install: Arc::new(Mutex::new(InstallState::default())),
            searxng_install: Mutex::new(InstallState::default()),
            searxng_available: AtomicBool::new(false),
            python_bin: Arc::new(Mutex::new(python_bin)),
            // Claude Code
            claude_code_process: Mutex::new(None),
            claude_code_install: Arc::new(Mutex::new(InstallState::default())),
            // Remote Access
            remote: Mutex::new(RemoteServer::new()),
            chat_workspace_overrides: Arc::new(Mutex::new(HashMap::new())),
            // Bug BB v2.5.0 — start in "auto" mode so existing installs are
            // unchanged until the user explicitly picks a GPU in Settings.
            gpu_selection: Mutex::new(GpuSelection::default()),
            flash_attn_cache: Mutex::new(HashMap::new()),
        }
    }
}

// On Windows, spawn child processes without flashing a console window.
// Applied to every taskkill/kill call so LU's process lifecycle stays invisible
// to the user. 0x08000000 = CREATE_NO_WINDOW.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

impl AppState {
    /// Kill every subprocess we spawned (ComfyUI, Ollama, Claude Code, Whisper).
    ///
    /// Live testing on 2026-05-25 showed that Tauri v2's `app.exit(0)` returns
    /// from the run loop on Windows WITHOUT actually dropping the managed
    /// `AppState` — the process exits before Drop fires, so children spawned
    /// in `auto_start_*` survived every "graceful" quit path (tray → Quit,
    /// auto-updater's `exit_app`, etc.). The `Drop` impl below is still
    /// correct, but we can't rely on it firing. Call this method explicitly
    /// from every quit path instead so kj103x's Ollama-orphan stays fixed even
    /// when Tauri's destructor chain skips us.
    pub fn shutdown_subprocesses(&self) {
        if let Ok(mut proc) = self.ollama_process.lock() {
            if let Some(ref mut child) = *proc {
                let pid = child.id();
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
                #[cfg(not(windows))]
                {
                    let _ = child.kill();
                    let _ = pid;
                }
                println!("[Ollama] Stopped (explicit shutdown)");
            }
        }

        if let Ok(mut proc) = self.comfy_process.lock() {
            if let Some(ref mut child) = *proc {
                let pid = child.id();
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
                #[cfg(not(windows))]
                {
                    let _ = child.kill();
                    let _ = pid;
                }
                println!("[ComfyUI] Stopped (explicit shutdown)");
            }
        }

        if let Ok(mut proc) = self.claude_code_process.lock() {
            if let Some(ref mut child) = *proc {
                let pid = child.id();
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
                #[cfg(not(windows))]
                {
                    let _ = child.kill();
                    let _ = pid;
                }
                println!("[ClaudeCode] Stopped (explicit shutdown)");
            }
        }

        if let Ok(mut whisper) = self.whisper.lock() {
            whisper.stop();
        }
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        // Belt-and-suspenders. Tauri v2 doesn't reliably drop the managed
        // state on `app.exit(0)` on Windows, so every quit path explicitly
        // calls `shutdown_subprocesses` itself (see `commands::system::exit_app`
        // and the tray "quit" handler in `main.rs`). This Drop covers the
        // remaining "Tauri-managed shutdown DID happen to run our Drop" case
        // — idempotent re-kill on already-dead PIDs is a harmless taskkill.
        self.shutdown_subprocesses();
    }
}
