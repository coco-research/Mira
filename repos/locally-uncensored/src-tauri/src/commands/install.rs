use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, State};
use tracing::{error, info};

use crate::python::venv_python_path;
use crate::state::{AppState, InstallState};

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── Disk-pressure pre-flight (Bug #1 — techx69 100%-busy-drive hang) ────────

/// Return a human-readable warning when the target install drive is short
/// on free space (<5 GB — ComfyUI + PyTorch wheels need ~5 GB) or its
/// pending I/O queue suggests sustained 100% utilisation. Best-effort —
/// returns None if sysinfo can't get reliable data, so we never block a
/// well-meaning install over a probing flake.
fn check_install_disk_pressure(target_dir: &Path) -> Option<String> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    // Find the disk that contains the target dir. sysinfo's Disk::mount_point
    // is a PathBuf — pick the longest mount that is a prefix of target_dir.
    let normalized = target_dir.to_path_buf();
    let mut best: Option<&sysinfo::Disk> = None;
    let mut best_len: usize = 0;
    for d in &disks {
        let mp = d.mount_point();
        if normalized.starts_with(mp) {
            let len = mp.as_os_str().len();
            if len > best_len {
                best_len = len;
                best = Some(d);
            }
        }
    }
    let disk = best?;

    let free_bytes = disk.available_space();
    let total_bytes = disk.total_space();
    let needed_bytes: u64 = 5 * 1024 * 1024 * 1024; // 5 GB
    if free_bytes < needed_bytes {
        return Some(format!(
            "⚠ Low disk space on {}: {:.1} GB free of {:.1} GB total. \
             ComfyUI + PyTorch need about 5 GB. Consider freeing space or \
             choosing a drive with more room before continuing.",
            disk.mount_point().to_string_lossy(),
            free_bytes as f64 / 1_073_741_824.0,
            total_bytes as f64 / 1_073_741_824.0,
        ));
    }
    None
}

#[tauri::command]
pub fn cancel_comfyui_install(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.comfyui_install_cancel.store(true, Ordering::SeqCst);
    if let Ok(mut s) = state.install_status.lock() {
        // Mark as cancelling immediately so the UI can switch to a
        // "Cancelling…" indicator even before the spawn loop notices.
        if s.status == "installing" || s.status == "downloading" {
            s.status = "cancelling".to_string();
            s.logs.push("Cancellation requested — waiting for active subprocess to exit…".to_string());
        }
    }
    Ok(serde_json::json!({"status": "cancelling"}))
}

// ── GPU helpers (Bug #10 — Blackwell PyTorch cu128 routing) ─────────────────

/// Probe NVIDIA's compute capability of the first detected GPU and return
/// its major version (8 for Ampere, 9 for Hopper, 12 for Blackwell, …).
///
/// `nvidia-smi --query-gpu=compute_cap` prints lines like `12.0` (one per
/// GPU). We take the highest major across visible GPUs because pip can
/// only install ONE PyTorch build — picking the higher capability set
/// satisfies every card on the box (cu128 wheels still run on Ampere etc.).
/// Returns None when nvidia-smi is absent or the parse fails; the caller
/// falls back to the previous default index URL.
fn parse_compute_cap_output(s: &str) -> Option<u32> {
    let mut max_major: Option<u32> = None;
    for line in s.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let major_str = trimmed.split('.').next().unwrap_or("");
        if let Ok(major) = major_str.parse::<u32>() {
            max_major = Some(max_major.map_or(major, |prev| prev.max(major)));
        }
    }
    max_major
}

fn detect_nvidia_compute_cap_major() -> Option<u32> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=compute_cap", "--format=csv,noheader,nounits"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    parse_compute_cap_output(&s)
}

// ── pip helpers (issue #32: PyTorch / ComfyUI install reliability) ───────────

/// Push a log line to the shared install state. Best-effort — silently
/// no-ops if the mutex is poisoned (which only happens if a thread panicked
/// while holding the lock; the install is already broken at that point).
fn push_install_log(state: &Arc<Mutex<InstallState>>, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.logs.push(msg.to_string());
    }
}

// ── PEP 668 / venv helpers (Bug E — rzgrozt Arch externally-managed) ─────────

/// True iff the Python pointed to by `python_bin` is PEP 668 protected
/// (Arch Linux, Debian 12+, Fedora 38+, Ubuntu 23.04+ ship Python with an
/// `EXTERNALLY-MANAGED` marker file in the stdlib dir, which makes
/// `python -m pip install ...` exit with
/// `error: externally-managed-environment` unless `--break-system-packages`
/// is passed). We probe by asking Python itself whether the marker exists
/// — robust against distro-specific path layouts and avoids parsing locale
/// dependent pip error strings.
///
/// Returns `false` on any probe error (Python missing, sysconfig broken,
/// stdout unparseable). That is the safe default: a false negative just
/// means we install without a venv exactly like LU did before this bug,
/// which is fine on every distro that *isn't* PEP 668 protected.
pub fn is_pep668_protected(python_bin: &str) -> bool {
    if python_bin.is_empty() {
        return false;
    }
    let mut cmd = Command::new(python_bin);
    cmd.args([
        "-c",
        "import os, sysconfig; \
         d = sysconfig.get_path('stdlib'); \
         print('YES' if os.path.exists(os.path.join(d, 'EXTERNALLY-MANAGED')) else 'NO')",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else { return false };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout).trim() == "YES"
}

/// Create a venv inside `comfyui_dir/venv` using the system `python_bin`.
/// Returns the path to the venv's Python interpreter on success. On Arch
/// boxes that haven't installed the `python-virtualenv` package this can
/// fail with `No module named venv` — we surface that with an actionable
/// hint pointing at the right pacman / apt invocation.
pub fn create_comfyui_venv(comfyui_dir: &Path, python_bin: &str) -> Result<PathBuf, String> {
    let venv_dir = comfyui_dir.join("venv");
    // venv is idempotent: re-running on an existing dir just no-ops, but be
    // explicit so the log reads cleanly.
    let already_existed = venv_dir.exists() && venv_python_path(comfyui_dir).exists();
    if already_existed {
        return Ok(venv_python_path(comfyui_dir));
    }

    let mut cmd = Command::new(python_bin);
    cmd.args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd
        .output()
        .map_err(|e| format!("Could not spawn `python -m venv`: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lower = stderr.to_lowercase();
        // Most common Arch / minimal-Python failure: stdlib venv module
        // isn't available because the distro packages it separately.
        if lower.contains("no module named venv") || lower.contains("ensurepip") {
            return Err(format!(
                "Python's `venv` module is not available. Install it first:\n\
                 • Arch:   sudo pacman -S python-virtualenv\n\
                 • Debian/Ubuntu: sudo apt install python3-venv\n\
                 • Fedora: sudo dnf install python3-virtualenv\n\
                 Then retry the ComfyUI install.\n\n--- python output ---\n{}",
                stderr.chars().take(400).collect::<String>()
            ));
        }
        return Err(format!(
            "venv creation failed: {}",
            stderr.chars().take(400).collect::<String>()
        ));
    }

    let venv_py = venv_python_path(comfyui_dir);
    if !venv_py.exists() {
        return Err(format!(
            "venv was created at {} but no Python binary appeared at {}. \
             This usually means the venv module is broken — try `sudo pacman -S python-virtualenv` (Arch) or the equivalent on your distro.",
            venv_dir.display(),
            venv_py.display()
        ));
    }
    Ok(venv_py)
}

/// Detect pip errors that warrant an automatic retry with backoff.
/// Conservative — only retries on errors caused by transient network
/// conditions, not on auth, permission, disk-full, or python-side bugs.
fn is_transient_pip_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("403 ")
        || lower.contains("502 ")
        || lower.contains("503 ")
        || lower.contains("504 ")
        || lower.contains("429 ")
        || lower.contains("sslerror")
        || lower.contains("ssl: ")
        || lower.contains("readtimeouterror")
        || lower.contains("connecttimeouterror")
        || lower.contains("connectiontimeouterror")
        || lower.contains("connectionerror")
        || lower.contains("connectionreseterror")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("connection refused")
        || lower.contains("incompleteread")
        || lower.contains("temporary failure")
        || lower.contains("network is unreachable")
        || lower.contains("could not fetch")
        || lower.contains("read timed out")
        || lower.contains("eof occurred in violation of protocol")
        || lower.contains("max retries exceeded")
}

/// Turn raw pip stderr into a user-friendly hint with troubleshooting
/// guidance. The first line of the returned string is a short diagnosis;
/// the rest is the truncated original error for context.
fn diagnose_pip_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let snippet: String = stderr.chars().take(400).collect();

    let hint = if lower.contains("externally-managed-environment")
        || lower.contains("error: externally-managed")
    {
        "Your Python is PEP 668 protected (Arch Linux, Debian 12+, Fedora 38+, \
         Ubuntu 23.04+ block system-wide pip installs by default). LU should have \
         created a venv inside the ComfyUI folder automatically — if you see this \
         error, the venv module is missing. Install it and retry:\n\
         • Arch:   sudo pacman -S python-virtualenv\n\
         • Debian/Ubuntu: sudo apt install python3-venv\n\
         • Fedora: sudo dnf install python3-virtualenv"
    } else if lower.contains("ssl") {
        "SSL error reaching pypi.org. Often caused by an antivirus / firewall \
         intercepting TLS, or a stale system clock. Disable TLS interception \
         for python.exe, fix the system clock, then retry."
    } else if lower.contains("403 ") {
        "HTTP 403 from pypi.org or pytorch.org. The mirror may be blocked on \
         your network. Try a different network or VPN, then retry."
    } else if lower.contains("429 ") {
        "Rate limited (HTTP 429). Wait a few minutes and retry."
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "Network timeout. Slow connection or congested mirror. Retry on a \
         faster network, or run the install during off-peak hours."
    } else if lower.contains("connection") {
        "Connection error. Check internet connectivity, restart the app, \
         and retry."
    } else if lower.contains("no space") || lower.contains("errno 28") {
        "Out of disk space. PyTorch + dependencies need ~5 GB free. Free up \
         space and retry."
    } else if lower.contains("permission") || lower.contains("errno 13") {
        "Permission denied. Make sure no other process is using Python, then \
         retry. On Windows: close any open Python REPLs / Jupyter / IDE \
         debuggers."
    } else if lower.contains("no module named") || lower.contains("modulenotfounderror") {
        "Python install is missing pip or is broken. Reinstall Python 3.10+ \
         from python.org with 'Add to PATH' checked."
    } else if lower.contains("could not find a version") {
        "No matching wheel for your Python version. ComfyUI needs Python \
         3.10, 3.11, or 3.12. Reinstall a supported Python version."
    } else {
        ""
    };

    if hint.is_empty() {
        snippet
    } else {
        format!("{}\n\n--- pip output ---\n{}", hint, snippet)
    }
}

/// Run a `python -m pip install ...` command, streaming its stdout + stderr
/// line-by-line into the install state's `logs` so the user sees live
/// progress instead of a frozen UI. Retries up to `max_attempts` times on
/// transient network errors with exponential backoff (10s, 30s, 90s).
///
/// On non-transient errors or after exhausting retries, returns Err with a
/// human-readable diagnosis prepended to the truncated original error.
/// Streaming pip install with retry. When `cancel` is `Some`, polls the
/// shared flag between line reads and waits, and kills the pip child on
/// cancel — used by `install_comfyui` so the user's Cancel button
/// (Bug #1 — techx69 v2.4.3) actually stops the running install instead
/// of waiting for pip to finish naturally. When `cancel` is `None`, the
/// install runs to completion as before — used by `install_python` and
/// callers that haven't been wired up to the new cancel flow.
pub fn pip_install_streaming_with_retry_cancellable(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    let mut delay_seconds = 10u64;
    let mut last_stderr = String::new();

    for attempt in 1..=max_attempts {
        if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err("cancelled".to_string());
        }
        if attempt > 1 {
            push_install_log(
                install_state,
                &format!(
                    "Transient network error — retry {}/{} after {}s wait...",
                    attempt, max_attempts, delay_seconds
                ),
            );
            // Sleep in 1-second chunks so cancel reacts within ~1s.
            for _ in 0..delay_seconds {
                if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                    return Err("cancelled".to_string());
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            delay_seconds = (delay_seconds * 3).min(180);
        }

        let mut cmd = Command::new(python_bin);
        cmd.args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Could not start pip ({}). Is Python on PATH?", e)),
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stderr_capture: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        // Stream stdout to install logs
        let stdout_state = install_state.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stdout_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        // Stream stderr to install logs AND capture for retry decision
        let stderr_state = install_state.clone();
        let stderr_capture_clone = stderr_capture.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut buf) = stderr_capture_clone.lock() {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stderr_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        // Poll for either the child to exit or the cancel flag to flip.
        // try_wait avoids blocking the cancel check; sleep keeps CPU idle.
        let exit_status = loop {
            if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                // Kill the child so pip doesn't keep saturating disk.
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err("cancelled".to_string());
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(e) => return Err(format!("pip wait failed: {}", e)),
            }
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        if exit_status.success() {
            return Ok(());
        }

        last_stderr = stderr_capture
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();

        if !is_transient_pip_error(&last_stderr) {
            return Err(diagnose_pip_error(&last_stderr));
        }
    }

    Err(format!(
        "Exhausted {} retry attempts for transient network errors.\n\n{}",
        max_attempts,
        diagnose_pip_error(&last_stderr)
    ))
}

#[tauri::command]
pub fn install_comfyui(
    install_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut install = state.install_status.lock().unwrap();
    if install.status == "installing" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.logs.push("Starting ComfyUI installation...".to_string());
    drop(install);

    info!("comfyui install start");

    // Reset cancel flag (Bug #1) — a previous cancelled install would
    // otherwise short-circuit the new run on first poll.
    state.comfyui_install_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.comfyui_install_cancel.clone();

    let target_dir = install_path
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("ComfyUI"));

    // Bug #1 (techx69): pre-flight disk pressure check. On a drive sitting
    // at 100% utilisation the install hangs for 45+ minutes and the app
    // OOMs. Surface the risk BEFORE we start — the user can free space
    // or pick a different drive instead of staring at a frozen progress
    // log. We don't refuse to start: some users will accept the slow path.
    if let Some(warning) = check_install_disk_pressure(&target_dir) {
        if let Ok(mut s) = state.install_status.lock() {
            s.logs.push(warning);
        }
    }

    // Pre-flight: refuse to start ComfyUI install without a real Python.
    // The frontend is expected to call `install_python` first when this
    // returns the "no python" error — that flow shows a Python-install
    // progress card before re-firing `install_comfyui`. The ComfyUI carcass
    // bug (P14) was caused by skipping this check: pip got fed the Microsoft
    // Store stub `python.exe`, which exit-1'd, leaving a half-cloned
    // ComfyUI dir on disk that LU then mistakenly detected as "installed".
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        // Reset install state so the frontend's polling sees the error
        // immediately — without this the spawned thread below never runs and
        // the UI sits on "installing" forever.
        let mut install = state.install_status.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "Python is not installed on this machine. \
             Install Python first (Settings → ComfyUI → Install Python, \
             or click 'Install Python' in the onboarding ComfyUI step), \
             then retry the ComfyUI install."
                .to_string(),
        );
        error!("comfyui install aborted: no usable python");
        return Err(
            "no_python: Python must be installed before ComfyUI. Call install_python first."
                .to_string(),
        );
    }
    let install_status = state.install_status.clone();

    std::thread::spawn(move || {
        // Helper to update install status + logs
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        let cancelled = || cancel_flag.load(Ordering::SeqCst);

        if cancelled() {
            update("cancelled", "Install cancelled before it started.");
            return;
        }

        // Bug N (juliandiggins-stack issue #40, 2026-05-18) — probe Windows
        // git BEFORE clone so a WSL/non-native git on PATH surfaces a clear
        // hint instead of failing the clone halfway with cryptic stderr.
        #[cfg(target_os = "windows")]
        {
            let probe = windows_git_probe();
            if let Some(hint) = windows_git_install_hint(&probe) {
                if probe == WindowsGitState::Missing {
                    update("error", &hint);
                    return;
                }
                // NonNative — log the warning to the install panel but
                // proceed; many MSYS/Cygwin gits handle Windows paths fine.
                update("downloading", &hint);
            }
        }

        // Step 1: Git clone — spawn+poll instead of cmd.output() so the
        // Cancel button can kill an in-flight clone (Bug #1).
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
        update("downloading", "Step 1/3: Downloading ComfyUI repository...");

        let mut cmd = Command::new("git");
        cmd.args(["clone", "https://github.com/comfyanonymous/ComfyUI.git"])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut clone_child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err = format!("Git is not installed or not in PATH: {}", e);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        };
        let clone_exit = loop {
            if cancelled() {
                let _ = clone_child.kill();
                let _ = clone_child.wait();
                update("cancelled", "Install cancelled during git clone.");
                return;
            }
            match clone_child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(250)),
                Err(e) => {
                    update("error", &format!("git wait failed: {}", e));
                    return;
                }
            }
        };

        if clone_exit.success() {
            println!("[Install] Git clone successful");
            update("installing", "Repository cloned successfully.");
        } else {
            let mut stderr = String::new();
            if let Some(mut e) = clone_child.stderr.take() {
                let _ = e.read_to_string(&mut stderr);
            }
            if stderr.contains("already exists") {
                println!("[Install] ComfyUI directory already exists, updating...");
                update("installing", "ComfyUI already exists, pulling latest...");
                if cancelled() {
                    update("cancelled", "Install cancelled.");
                    return;
                }
                let mut pull = Command::new("git");
                pull.args(["pull"]).current_dir(&target_dir)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pull.creation_flags(CREATE_NO_WINDOW);
                let _ = pull.output();
            } else {
                let err = format!("Git clone failed: {}", stderr);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        if cancelled() {
            update("cancelled", "Install cancelled after clone.");
            return;
        }

        // Bug E (rzgrozt — Arch GH #32 comment, 2026-05-08): if the system
        // Python is PEP 668 protected (Arch, Debian 12+, Fedora 38+, Ubuntu
        // 23.04+), a bare `python -m pip install ...` exits with
        // `error: externally-managed-environment` and leaves the user with
        // a half-cloned ComfyUI dir and no diagnostic. Detect the marker
        // file via the system Python, then create a venv inside the
        // ComfyUI folder and use the venv's Python for every subsequent
        // pip step. The launcher in `process.rs` mirrors this check and
        // prefers the venv when starting ComfyUI, so the user gets a
        // consistent isolated environment without ever touching pacman.
        let effective_python = if is_pep668_protected(&python_bin) {
            update(
                "installing",
                "Python is PEP 668 protected (Arch / Debian 12+ / Fedora 38+ / \
                 Ubuntu 23.04+). Creating an isolated venv at ComfyUI/venv so \
                 pip can install PyTorch + ComfyUI deps without touching your \
                 system Python …",
            );
            match create_comfyui_venv(&target_dir, &python_bin) {
                Ok(venv_py) => {
                    let p = venv_py.to_string_lossy().to_string();
                    update(
                        "installing",
                        &format!("venv ready — using {} for the install.", p),
                    );
                    p
                }
                Err(e) => {
                    update("error", &format!("venv creation failed.\n\n{}", e));
                    return;
                }
            }
        } else {
            python_bin.clone()
        };

        // Step 2: Detect GPU and install PyTorch
        let mut nv = Command::new("nvidia-smi");
        nv.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        nv.creation_flags(CREATE_NO_WINDOW);
        let has_nvidia = nv.output().map(|o| o.status.success()).unwrap_or(false);

        // Bug #10 (vokurta — RTX 6000 Blackwell, 2026-05-11): SM 12.0 GPUs
        // need PyTorch cu128 wheels. cu121 stops at sm_90 (Hopper); on
        // Blackwell the kernel simply isn't shipped and the first compute
        // call dies with "CUDA error: no kernel image is available for
        // execution on the device". We probe `--query-gpu=compute_cap` and
        // pick the wheel set accordingly. Falls back to cu121 if the probe
        // fails for any reason — that's the previous behaviour, so we
        // never regress existing setups.
        let compute_cap_major = if has_nvidia { detect_nvidia_compute_cap_major() } else { None };
        let pytorch_index = match compute_cap_major {
            Some(major) if major >= 12 => Some("https://download.pytorch.org/whl/cu128"),
            Some(_) => Some("https://download.pytorch.org/whl/cu121"),
            None if has_nvidia => Some("https://download.pytorch.org/whl/cu121"),
            None => None,
        };

        let gpu_info = match (has_nvidia, compute_cap_major) {
            (true, Some(major)) if major >= 12 => "NVIDIA Blackwell GPU detected (SM 12.0+) — installing PyTorch cu128",
            (true, Some(_)) => "NVIDIA GPU detected — installing CUDA PyTorch (cu121)",
            (true, None) => "NVIDIA GPU detected (compute capability probe failed) — falling back to cu121",
            (false, _) => "No NVIDIA GPU — installing CPU PyTorch",
        };
        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/3: {}", gpu_info));
        update(
            "installing",
            "Downloading PyTorch + Torchvision + Torchaudio (~2 GB total). \
             On a typical home connection this takes 10–15 minutes; on slower \
             links it can be longer. Live pip output below — if you see new \
             lines appearing, the install is making progress, not hung.",
        );

        let torch_args: Vec<&str> = if let Some(index_url) = pytorch_index {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
                "--index-url", index_url,
            ]
        } else {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
            ]
        };

        match pip_install_streaming_with_retry_cancellable(&torch_args, &effective_python, 3, &install_status, Some(&cancel_flag)) {
            Ok(()) => {
                update("installing", "PyTorch installed successfully.");
            }
            Err(diagnosis) if diagnosis == "cancelled" => {
                update("cancelled", "Install cancelled during PyTorch download.");
                return;
            }
            Err(diagnosis) => {
                let err = format!("PyTorch installation failed.\n\n{}", diagnosis);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        if cancelled() {
            update("cancelled", "Install cancelled before requirements install.");
            return;
        }

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        update("installing", "Step 3/3: Installing ComfyUI dependencies (live pip output below)...");

        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry_cancellable(&req_args, &effective_python, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => {
                    update("installing", "Dependencies installed successfully.");
                }
                Err(diagnosis) if diagnosis == "cancelled" => {
                    update("cancelled", "Install cancelled during requirements install.");
                    return;
                }
                Err(diagnosis) => {
                    // Don't fail the whole install — some optional deps may fail
                    // but ComfyUI can still start and the user can fix them later.
                    println!("[Install] Requirements install warning: {}", diagnosis);
                    update("installing", "Some optional dependencies had warnings (non-critical, ComfyUI should still start).");
                }
            }
        }

        println!("[Install] ComfyUI installation complete");
        update("complete", "ComfyUI installed successfully!");
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.install_status.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ── Shared helper: download a file with progress tracking ────────────────────

fn download_file_blocking(
    url: &str,
    dest: &PathBuf,
    install_state: &Arc<Mutex<InstallState>>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("LocallyUncensored/2.3")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client.get(url).send().map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    if let Ok(mut s) = install_state.lock() {
        s.download_total = total;
        s.status = "downloading".to_string();
    }

    let mut file = fs::File::create(dest).map_err(|e| format!("Create file: {}", e))?;
    let mut reader = std::io::BufReader::new(response);
    let mut downloaded: u64 = 0;
    let start = Instant::now();
    let mut last_update = Instant::now();
    let mut buf = [0u8; 65536]; // 64KB chunks

    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("Write: {}", e))?;
        downloaded += n as u64;

        if last_update.elapsed().as_millis() > 500 {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let speed = downloaded as f64 / elapsed;
            if let Ok(mut s) = install_state.lock() {
                s.download_progress = downloaded;
                s.download_speed = speed;
            }
            last_update = Instant::now();
        }
    }

    // Final update
    if let Ok(mut s) = install_state.lock() {
        s.download_progress = downloaded;
        s.download_total = downloaded; // in case Content-Length was missing
        s.download_speed = 0.0;
    }

    Ok(())
}

// ── Ollama Install ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn install_ollama(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.ollama_install.lock().unwrap();
    if install.status == "downloading" || install.status == "installing" || install.status == "starting" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install.logs.push("Downloading Ollama installer...".to_string());
    drop(install);

    info!("ollama install start");

    let ollama_state = state.ollama_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = ollama_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Bug G (discovered during 2026-05-17 Arch live test): pre-fix
        // install_ollama unconditionally downloaded OllamaSetup.exe (a
        // Windows-only NSIS installer) and tried to execute it with /S.
        // On Linux that fails with "Exec format error" and on macOS with
        // a similar binary-format mismatch — the user sees a cryptic
        // install failure with no path forward. Dispatch by platform.
        #[cfg(target_os = "windows")]
        {
            install_ollama_windows_impl(&ollama_state, update);
        }
        #[cfg(target_os = "linux")]
        {
            install_ollama_linux_impl(&ollama_state, update);
        }
        #[cfg(target_os = "macos")]
        {
            install_ollama_macos_impl(&ollama_state, update);
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

/// Bug I — Linux distro detection for the install_python error hint.
/// Parses `/etc/os-release` line-by-line, collects `ID` and `ID_LIKE`
/// tokens (stripping the quotes that systemd allows around multi-value
/// fields like `ID_LIKE="rhel centos fedora"`), and returns a distro
/// family install command. Pulled out so we can unit test the matching
/// logic without writing to /etc on the test box.
pub fn linux_python_install_hint(os_release: &str) -> String {
    // Collect family tokens from ID and ID_LIKE.
    let mut families: Vec<String> = Vec::new();
    for line in os_release.lines() {
        let trimmed = line.trim();
        let (key, value) = match trimmed.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim().to_lowercase();
        if key != "id" && key != "id_like" {
            continue;
        }
        // Strip surrounding quotes if present, then split on whitespace
        // (ID_LIKE often carries multiple space-separated tokens).
        let value = value.trim().trim_matches('"').trim_matches('\'');
        for token in value.split_whitespace() {
            families.push(token.to_lowercase());
        }
    }
    let has = |needle: &str| families.iter().any(|f| f == needle);

    if has("arch") || has("manjaro") || has("endeavouros") || has("garuda") {
        "`sudo pacman -S python python-pip`".to_string()
    } else if has("debian") || has("ubuntu") || has("linuxmint") || has("pop") || has("elementary") {
        "`sudo apt install python3 python3-pip python3-venv`".to_string()
    } else if has("fedora") || has("rhel") || has("centos") || has("rocky") || has("almalinux") {
        "`sudo dnf install python3 python3-pip`".to_string()
    } else if has("opensuse") || has("opensuse-tumbleweed") || has("opensuse-leap") || has("suse") || has("sles") {
        "`sudo zypper install python3 python3-pip`".to_string()
    } else {
        "your distro's package manager".to_string()
    }
}

/// Bug N — git probe before ComfyUI install (juliandiggins-stack issue #40).
///
/// On Windows the in-app ComfyUI install + custom-node install both shell out
/// to `git clone`. The previous spawn-error guard only catches a flat
/// "git not on PATH" — but on a Windows machine where a WSL / Linux-mounted
/// git binary is first on PATH, `git --version` succeeds and clone *starts*,
/// then dies because the Linux binary can't handle Windows-style target paths.
/// juliandiggins-stack hit this on v2.4.5: clone silently fails, user gets
/// a half-installed ComfyUI with no actionable hint.
///
/// Probe at start of every clone path, classify, and surface the right hint:
/// Missing → "install Git for Windows", NonNative → "WSL/non-native git on
/// PATH may break Windows-path clones", Native → proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowsGitState {
    /// `git --version` failed to run (not installed or not on PATH).
    Missing,
    /// `git version 2.x.x.windows.y` — Git for Windows. Clone will work.
    Native,
    /// `git --version` ran but output doesn't include the `.windows` tag —
    /// could be WSL git, MSYS git, Cygwin git, or something else. May work,
    /// may break on Windows paths. Surface a soft warning, proceed anyway.
    NonNative,
}

/// Pure helper for testability. Classifies a `git --version` invocation
/// from its stdout (trimmed) plus the spawn/exit status.
pub fn windows_git_probe_from_output(stdout: &str, exited_successfully: bool) -> WindowsGitState {
    if !exited_successfully {
        return WindowsGitState::Missing;
    }
    let lower = stdout.to_lowercase();
    if !lower.starts_with("git version") {
        // Some non-git binary on PATH that responded to --version with garbage.
        return WindowsGitState::Missing;
    }
    if lower.contains(".windows") {
        WindowsGitState::Native
    } else {
        WindowsGitState::NonNative
    }
}

/// Run `git --version` and classify. Only meaningful on Windows; on other
/// platforms a stock `git` is fine.
#[cfg(target_os = "windows")]
pub fn windows_git_probe() -> WindowsGitState {
    let mut cmd = Command::new("git");
    cmd.arg("--version").creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            windows_git_probe_from_output(&stdout, true)
        }
        _ => WindowsGitState::Missing,
    }
}

/// User-facing hint for the probed state. Returns `None` for Native (no hint
/// needed). For Missing the hint is fatal; for NonNative it's a soft warning.
pub fn windows_git_install_hint(state: &WindowsGitState) -> Option<String> {
    match state {
        WindowsGitState::Native => None,
        WindowsGitState::Missing => Some(
            "Git is not installed or not on PATH. Install Git for Windows from \
             https://git-scm.com/download/win and restart LU so the new PATH \
             is picked up.".to_string(),
        ),
        WindowsGitState::NonNative => Some(
            "A non-native `git` binary is first on PATH (likely WSL or a Linux \
             mount). It may fail to clone into Windows-style paths. If the \
             ComfyUI install errors out during clone, install Git for Windows \
             from https://git-scm.com/download/win and make sure its `cmd` \
             folder is ahead of any WSL git in your PATH.".to_string(),
        ),
    }
}

/// Git availability for the Codex coding view (v2.5.0). The coding agent shells
/// out to `git` for `git_status`/`git_diff`/`git_commit`/`git_log`, so if git
/// isn't on PATH those tools fail with confusing errors. The Codex view calls
/// this on open and, when git is missing, shows a minimal "Install Git" banner.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GitStatus {
    /// `git --version` ran successfully.
    pub installed: bool,
    /// Windows: Git-for-Windows (clone-safe). Other OS: same as `installed`.
    pub native: bool,
    /// The raw `git --version` line, when available.
    pub version: Option<String>,
    /// User-facing hint when missing / non-native; `None` when all good.
    pub hint: Option<String>,
    /// Platform-correct git download page for the install button.
    pub download_url: String,
}

/// Run `git --version` (no console window on Windows) and return the trimmed
/// stdout line, or `None` if git is missing / failed to run.
fn git_version_string() -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

/// Platform-correct git download page.
fn git_download_url() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "https://git-scm.com/download/win"
    }
    #[cfg(target_os = "macos")]
    {
        "https://git-scm.com/download/mac"
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        "https://git-scm.com/download/linux"
    }
}

/// Cross-platform git availability check for the Codex view's install banner.
#[tauri::command]
pub fn check_git_installed() -> GitStatus {
    let download_url = git_download_url().to_string();
    let version = git_version_string();

    #[cfg(target_os = "windows")]
    {
        let state = windows_git_probe();
        GitStatus {
            installed: state != WindowsGitState::Missing,
            native: state == WindowsGitState::Native,
            version,
            hint: windows_git_install_hint(&state),
            download_url,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let installed = version.is_some();
        GitStatus {
            installed,
            native: installed,
            version,
            hint: if installed {
                None
            } else {
                Some(
                    "Git is not installed or not on PATH. Install it from your \
                     package manager (e.g. `sudo apt install git`, `brew install \
                     git`) or https://git-scm.com/downloads, then restart LU so the \
                     new PATH is picked up."
                        .to_string(),
                )
            },
            download_url,
        }
    }
}

/// Wait for Ollama HTTP API to respond on the default port (best-effort
/// shared startup probe used after every platform-specific install path).
fn wait_for_ollama_ready() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();
    for i in 0..15 {
        std::thread::sleep(std::time::Duration::from_secs(2));
        match client.get("http://localhost:11434/api/tags").send() {
            Ok(res) if res.status().is_success() => return true,
            _ => println!("[Ollama] Not ready yet, attempt {}/15", i + 1),
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn install_ollama_windows_impl<F: Fn(&str, &str)>(
    ollama_state: &Arc<Mutex<InstallState>>,
    update: F,
) {
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join("OllamaSetup.exe");
    println!("[Ollama] Downloading OllamaSetup.exe...");
    if let Err(e) = download_file_blocking(
        "https://ollama.com/download/OllamaSetup.exe",
        &installer_path,
        ollama_state,
    ) {
        update("error", &format!("Download failed: {}", e));
        return;
    }
    update("installing", "Download complete. Installing Ollama...");
    let mut cmd = Command::new(&installer_path);
    cmd.arg("/S");
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(o) => {
            let code = o.status.code().unwrap_or(-1);
            update("starting", &format!("Installer finished (code {}). Starting Ollama...", code));
        }
        Err(e) => {
            update("error", &format!("Could not run installer: {}", e));
            return;
        }
    }
    let _ = fs::remove_file(&installer_path);
    let mut serve = Command::new("ollama");
    serve.arg("serve").stdout(Stdio::piped()).stderr(Stdio::piped());
    serve.creation_flags(CREATE_NO_WINDOW);
    let _ = serve.spawn();
    update("starting", "Waiting for Ollama to start...");
    if wait_for_ollama_ready() {
        update("complete", "Ollama is ready!");
    } else {
        update("error", "Ollama installed but not responding. Try restarting the app.");
    }
}

#[cfg(target_os = "linux")]
fn install_ollama_linux_impl<F: Fn(&str, &str)>(
    _ollama_state: &Arc<Mutex<InstallState>>,
    update: F,
) {
    // If `ollama` is already on PATH (pacman -S ollama, manual install, etc.),
    // skip ahead to spawning the service.
    let already_installed = Command::new("which")
        .arg("ollama")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !already_installed {
        // Bug G revisit (2026-05-17 live test on Arch VM): Ollama's GitHub
        // release assets changed format. The old `ollama-linux-amd64` raw
        // binary URL now returns 404 — current releases ship as
        // `ollama-linux-amd64.tar.zst` which bundles the CUDA runtime libs
        // (multi-GB tarball). Auto-downloading 2-3 GB from a desktop-app
        // install button isn't user-friendly, so we surface a clear distro-
        // specific install hint instead. Every modern Linux distro ships an
        // ollama package or accepts ollama.com/install.sh; pointing at the
        // right command beats a stuck 2-GB progress bar.
        let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let suggestion = linux_ollama_install_hint(&os_release);
        update(
            "error",
            &format!(
                "Ollama auto-install on Linux isn't supported — current releases \
                 are multi-GB tarballs with bundled CUDA libs that are too large \
                 to fetch from an install button.\n\n\
                 Install via your distro: {}\n\n\
                 After install, click 'Re-detect' here.",
                suggestion
            ),
        );
        return;
    }

    // ollama is already on PATH — spawn it and poll the API.
    update("starting", "Ollama is already installed — starting service...");
    let mut serve = Command::new("ollama");
    serve.arg("serve").stdout(Stdio::piped()).stderr(Stdio::piped());
    let _ = serve.spawn();

    update("starting", "Waiting for Ollama to start...");
    if wait_for_ollama_ready() {
        update("complete", "Ollama is ready!");
    } else {
        update(
            "error",
            "Ollama is installed but the API isn't responding on localhost:11434. \
             Open a terminal and run `ollama serve` manually to see the failure \
             message — common causes: another process already binding 11434, or \
             missing GPU drivers.",
        );
    }
}

/// Bug G revisit — distro-specific install command for `ollama`. Same parsing
/// shape as `linux_python_install_hint` (ID + ID_LIKE tokens, quoted values
/// handled). Falls back to ollama.com/install.sh for unknown distros.
pub fn linux_ollama_install_hint(os_release: &str) -> String {
    let mut families: Vec<String> = Vec::new();
    for line in os_release.lines() {
        let trimmed = line.trim();
        let (key, value) = match trimmed.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim().to_lowercase();
        if key != "id" && key != "id_like" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        for token in value.split_whitespace() {
            families.push(token.to_lowercase());
        }
    }
    let has = |needle: &str| families.iter().any(|f| f == needle);
    if has("arch") || has("manjaro") || has("endeavouros") || has("garuda") {
        "`sudo pacman -S ollama`".to_string()
    } else if has("debian") || has("ubuntu") || has("linuxmint") || has("pop") || has("elementary") {
        "`sudo apt install ollama` (Debian 12+ / Ubuntu 23.10+) or `curl -fsSL https://ollama.com/install.sh | sh`".to_string()
    } else if has("fedora") || has("rhel") || has("centos") || has("rocky") || has("almalinux") {
        "`curl -fsSL https://ollama.com/install.sh | sh`".to_string()
    } else if has("opensuse") || has("opensuse-tumbleweed") || has("opensuse-leap") || has("suse") {
        "`sudo zypper install ollama` (Tumbleweed) or `curl -fsSL https://ollama.com/install.sh | sh`".to_string()
    } else {
        "`curl -fsSL https://ollama.com/install.sh | sh` (official) or download manually from https://ollama.com/download/linux".to_string()
    }
}

#[cfg(target_os = "macos")]
fn install_ollama_macos_impl<F: Fn(&str, &str)>(
    _ollama_state: &Arc<Mutex<InstallState>>,
    update: F,
) {
    if Command::new("which").arg("ollama").output().map(|o| o.status.success()).unwrap_or(false) {
        update("starting", "Ollama already installed — starting service...");
        let mut serve = Command::new("ollama");
        serve.arg("serve").stdout(Stdio::piped()).stderr(Stdio::piped());
        let _ = serve.spawn();
        if wait_for_ollama_ready() {
            update("complete", "Ollama is ready!");
        } else {
            update("error", "Ollama is installed but the API isn't responding. Try restarting Ollama.app.");
        }
        return;
    }
    // We don't auto-install on macOS because the official distribution is
    // the signed Ollama.app from ollama.com/download/mac. Surfacing a clear
    // pointer beats trying to script around macOS gatekeeper.
    update(
        "error",
        "On macOS, download Ollama.app from https://ollama.com/download/mac and \
         move it to /Applications, then come back here and click Re-detect.",
    );
}

#[tauri::command]
pub fn install_ollama_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.ollama_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ── LM Studio Install (Windows) ─────────────────────────────────────────────
//
// LM Studio doesn't run as a Windows service like Ollama — it's a desktop app
// whose embedded server is started via either the GUI ("Server" tab) or the
// `lms` CLI (`lms server start`). The install flow here:
//   1. Download the official LM Studio installer .exe
//   2. Silent install with /S (NSIS / electron-builder convention)
//   3. Run `lms bootstrap` to register the CLI on PATH
//   4. Start the server on port 1234 via `lms server start --cors`
//
// Step 4 is what makes this Plug & Play — without it the user has to manually
// open the app and toggle the server, which is exactly the "version one
// usability cliff" we're trying to remove. If lms isn't on PATH yet (e.g.
// install is too fresh), we look in `%USERPROFILE%/.lmstudio/bin/lms.exe`
// directly.
//
// The hard-coded URL points to a known-stable release. LM Studio's installer
// host doesn't expose a /latest redirect — every version is its own URL — so
// the alternative would be to bake in a remote-version-check, which adds an
// extra failure mode for offline users. A stale URL just means the user gets
// a slightly older LM Studio; functionally fine.
const LMSTUDIO_INSTALLER_URL: &str =
    "https://installers.lmstudio.ai/win32/x64/0.3.16-6/LM-Studio-0.3.16-6-x64.exe";
const LMSTUDIO_DEFAULT_PORT: u16 = 1234;

fn lmstudio_lms_path() -> Option<PathBuf> {
    // Post-bootstrap: `lms bootstrap` materialises the launcher here and adds
    // the same path to PATH. Cheapest check first.
    let direct = dirs::home_dir().map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
    if let Some(ref p) = direct {
        if p.exists() {
            return direct;
        }
    }

    // Pre-bootstrap: on a fresh install, lms.exe ships inside the GUI app's
    // resources dir before `lms bootstrap` ever runs. Calling this binary
    // directly is how we *do* the bootstrap on a brand-new box — without it
    // the user has to open LM Studio once from the Start menu just to seed
    // the CLI, which is exactly the noob-cliff this sweep is removing.
    let webpack_suffix = ["resources", "app", ".webpack", "lms.exe"];
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let mut pre_bootstrap = PathBuf::from(la);
        pre_bootstrap.push("Programs");
        pre_bootstrap.push("LM Studio");
        for s in &webpack_suffix { pre_bootstrap.push(s); }
        if pre_bootstrap.exists() {
            return Some(pre_bootstrap);
        }
    }

    // System-wide install path: when LM Studio's installer is run "for all
    // users" (or installed via an MSI deployment), it lands in
    // %PROGRAMFILES%\LM Studio\. techx69 confirmed (2026-05-06): the
    // per-user-only lookup made LU report "no LM Studio detected" even with
    // `~/.lmstudio/models/` already populated.
    for env_var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"] {
        if let Ok(pf) = std::env::var(env_var) {
            let mut sys_wide = PathBuf::from(pf);
            sys_wide.push("LM Studio");
            for s in &webpack_suffix { sys_wide.push(s); }
            if sys_wide.exists() {
                return Some(sys_wide);
            }
        }
    }

    // Registry-based fallback: LM Studio's installer writes its install dir
    // under HKCU or HKLM Uninstall keys. Reading the registry lets us catch
    // exotic install dirs (e.g. user moved it to D:\Apps\LM Studio\).
    #[cfg(target_os = "windows")]
    if let Some(p) = lmstudio_path_from_registry() {
        let candidate = p.join("resources").join("app").join(".webpack").join("lms.exe");
        if candidate.exists() {
            return Some(candidate);
        }
        // Some builds drop lms.exe at the install root.
        let root_candidate = p.join("lms.exe");
        if root_candidate.exists() {
            return Some(root_candidate);
        }
    }

    // Last resort: PATH lookup. Catches non-standard installs (Chocolatey,
    // user-relocated install dir, etc.).
    if let Ok(out) = Command::new("where").arg("lms").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

/// Soft-detect LM Studio by scanning `~/.lmstudio/models/` for GGUF files.
/// Returns the number of GGUF files found (0 if the dir is missing or empty).
///
/// Rationale: even when `lms.exe` isn't on any search path (system-wide
/// install missed by our fallback, GUI never launched, etc.), the presence
/// of GGUFs in the canonical models dir is a strong signal that the user
/// *has* LM Studio and just hasn't started the server. Surfacing that in the
/// onboarding lets us show "LM Studio models detected — start server?" instead
/// of the dead-end "no LM Studio".
fn lmstudio_models_present() -> u32 {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return 0,
    };
    let models_dir = home.join(".lmstudio").join("models");
    if !models_dir.exists() {
        return 0;
    }
    // The standard layout is ~/.lmstudio/models/<publisher>/<repo>/<file>.gguf —
    // up to three levels deep. We walk lazily and stop after the first 1000
    // matches; the user does not care about the exact count past "many".
    fn walk(dir: &Path, depth: u32, found: &mut u32) {
        if *found >= 1000 || depth > 4 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, found);
            } else if path.extension().and_then(|e| e.to_str()).map(|s| s.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                *found += 1;
                if *found >= 1000 {
                    return;
                }
            }
        }
    }
    let mut count: u32 = 0;
    walk(&models_dir, 0, &mut count);
    count
}

#[cfg(target_os = "windows")]
fn lmstudio_path_from_registry() -> Option<PathBuf> {
    // Read InstallLocation from LM Studio's Uninstall entry. We try HKCU
    // first (per-user installs) then HKLM (system-wide). The display name
    // varies slightly between installer builds, so we scan for any subkey
    // whose DisplayName starts with "LM Studio".
    use winreg::enums::*;
    use winreg::RegKey;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for uninstall_path in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            let Ok(uninstall) = root.open_subkey(uninstall_path) else { continue };
            for key_res in uninstall.enum_keys() {
                let Ok(key) = key_res else { continue };
                let Ok(sub) = uninstall.open_subkey(&key) else { continue };
                let name: String = sub.get_value("DisplayName").unwrap_or_default();
                if name.eq_ignore_ascii_case("LM Studio") || name.starts_with("LM Studio") {
                    if let Ok(loc) = sub.get_value::<String, _>("InstallLocation") {
                        let p = PathBuf::from(loc);
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn lmstudio_path_from_registry() -> Option<PathBuf> {
    None
}

/// Path to the LM Studio GUI executable on Windows. We only need to launch
/// this in the rare case where `lms bootstrap` from the pre-bootstrap binary
/// reports success but `~/.lmstudio/` is still missing — some installs
/// require a one-time GUI launch to populate user-data dirs before
/// `lms bootstrap` will register the CLI on PATH.
fn lmstudio_gui_exe() -> Option<PathBuf> {
    let la = std::env::var("LOCALAPPDATA").ok()?;
    let p = PathBuf::from(la)
        .join("Programs")
        .join("LM Studio")
        .join("LM Studio.exe");
    if p.exists() { Some(p) } else { None }
}

/// Fast, BOUNDED reachability probe for the LM Studio server. A plain HTTP GET
/// to a DOWN server is catastrophically slow on some Windows boxes: connecting
/// to a closed `127.0.0.1:<port>` can take ~2 s to refuse (the IPv4 loopback
/// SYN is silently dropped by the firewall → TCP retransmit timeout), and
/// `reqwest`'s request `timeout` does NOT bound the connect phase tightly, so
/// the GET ran 2–7 s. Worse, the model-selector re-polls the LM-Studio
/// loaded-state every ~1.5 s while open, and the commands were SYNCHRONOUS
/// (→ main thread), so each stacked multi-second probe froze the whole UI.
/// `TcpStream::connect_timeout` hard-caps the down-case at 300 ms; the explicit
/// `127.0.0.1` (not `localhost`) skips the slow IPv4/IPv6 happy-eyeballs dance.
fn lmstudio_port_open() -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), LMSTUDIO_DEFAULT_PORT);
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok()
}

fn lmstudio_server_running() -> bool {
    // Bail in <=300 ms when nothing is listening — see lmstudio_port_open.
    if !lmstudio_port_open() {
        return false;
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .connect_timeout(std::time::Duration::from_millis(400))
        .no_proxy()
        .build();
    if let Ok(c) = client {
        return c
            .get(format!("http://127.0.0.1:{}/v1/models", LMSTUDIO_DEFAULT_PORT))
            .send()
            .map(|r| r.status().is_success() || r.status() == 401)
            .unwrap_or(false);
    }
    false
}

#[tauri::command]
pub fn install_lmstudio(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.lmstudio_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Downloading LM Studio installer...".to_string());
    drop(install);

    let lms_state = state.lmstudio_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = lms_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Bug H (discovered during 2026-05-17 Arch live test): pre-fix
        // install_lmstudio unconditionally downloaded LMStudioSetup.exe
        // (Windows installer) and tried to `cmd.arg("/S")` it. On Linux
        // the execve crashes with "Exec format error"; on macOS the
        // mismatch is the same. LM Studio's Linux distribution is an
        // AppImage whose URL rotates with every release, so we can't
        // mirror it from a stable in-binary string — surface a clear
        // download pointer instead of pretending to auto-install.
        #[cfg(target_os = "linux")]
        {
            update(
                "error",
                "LM Studio's Linux distribution is an AppImage with a URL that \
                 rotates per release. Download it from https://lmstudio.ai/download \
                 (pick 'Linux AppImage'), `chmod +x` the file, run it once to \
                 finish bootstrap, then come back to LU and click Re-detect.\n\n\
                 Tip: if you prefer the CLI-only path, the `lms` CLI ships with \
                 the AppImage and lands at ~/.lmstudio/bin/lms after first run.",
            );
            return;
        }
        #[cfg(target_os = "macos")]
        {
            update(
                "error",
                "On macOS, download LM Studio.app from https://lmstudio.ai/download, \
                 drag it to /Applications, launch it once to finish setup, then \
                 come back to LU and click Re-detect.",
            );
            return;
        }

        // Pre-check: if LM Studio is already installed (an `lms.exe` is
        // findable in any of the locations `lmstudio_lms_path()` knows about)
        // we skip the ~570 MB download entirely. Re-installing on a box where
        // it's already there was the previous behaviour and made the
        // "LM Studio detected but server offline" Plug-and-Play scenario
        // turn into a 5-minute no-op download. The bootstrap + server-start
        // steps below are idempotent, so the same code path now serves both
        // first-install and offline-reactivation users.
        let already_installed = lmstudio_lms_path().is_some();
        if already_installed && lmstudio_server_running() {
            update(
                "complete",
                "LM Studio is already installed and the server is up on localhost:1234.",
            );
            return;
        }

        if already_installed {
            update(
                "starting",
                "LM Studio is already installed — skipping download. Bootstrapping CLI and starting server…",
            );
        } else {
            let temp_dir = std::env::temp_dir();
            let installer_path = temp_dir.join("LMStudioSetup.exe");

            println!("[LMStudio] Downloading {}", LMSTUDIO_INSTALLER_URL);
            if let Err(e) =
                download_file_blocking(LMSTUDIO_INSTALLER_URL, &installer_path, &lms_state)
            {
                let err = format!(
                    "Download failed: {}. If the network is fine, the installer URL may have rotated — fall back to https://lmstudio.ai/download in your browser.",
                    e
                );
                println!("[LMStudio] {}", err);
                update("error", &err);
                return;
            }

            update(
                "installing",
                "Download complete. Running silent installer (this can take a minute)...",
            );

            // electron-builder NSIS supports /S for silent install. Ignore exit
            // code: real failures surface via the absence of lms.exe afterwards.
            let mut cmd = Command::new(&installer_path);
            cmd.arg("/S");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.output() {
                Ok(_) => println!("[LMStudio] Installer finished"),
                Err(e) => {
                    let err = format!("Could not run installer: {}", e);
                    println!("[LMStudio] {}", err);
                    update("error", &err);
                    return;
                }
            }

            let _ = fs::remove_file(&installer_path);
        }

        // Bootstrap the lms CLI. We do this in two passes:
        //   (1) Run `lms bootstrap` from whatever path `lmstudio_lms_path()`
        //       resolves — on a fresh install that's the pre-bootstrap binary
        //       inside `resources/app/.webpack/lms.exe`. This alone is enough
        //       on most boxes.
        //   (2) Verify that ~/.lmstudio/bin/lms.exe now exists. If not, some
        //       LM Studio builds require the GUI to run once to populate
        //       ~/.lmstudio/ before the bootstrap registers a launcher there.
        //       In that case we briefly launch the GUI, wait for ~/.lmstudio/
        //       to appear, retry bootstrap, then move on. The user sees the
        //       GUI flash up — not ideal, but strictly better than the old
        //       "Open LM Studio once from the Start menu" error dialog and a
        //       failed install.
        update("starting", "Bootstrapping `lms` CLI...");
        let initial_lms = lmstudio_lms_path();
        match &initial_lms {
            Some(p) => {
                let mut bs = Command::new(p);
                bs.arg("bootstrap");
                #[cfg(target_os = "windows")]
                bs.creation_flags(CREATE_NO_WINDOW);
                let _ = bs.output();
            }
            None => {
                update(
                    "error",
                    "LM Studio installed but `lms.exe` not found in any expected location. \
                     The installer may have failed silently. Try installing LM Studio manually \
                     from https://lmstudio.ai/download and then click Re-Scan.",
                );
                return;
            }
        }

        // Did pass 1 produce ~/.lmstudio/bin/lms.exe?  If yes, skip the GUI
        // dance entirely. If no, fall back to launching the GUI so it seeds
        // its user-data dir, then retry bootstrap.
        let post_bootstrap_path = dirs::home_dir()
            .map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
        let needs_gui_seed = post_bootstrap_path
            .as_ref()
            .map(|p| !p.exists())
            .unwrap_or(true);

        if needs_gui_seed {
            update(
                "starting",
                "Launching LM Studio briefly to finalise CLI setup (you may see the window flash)...",
            );
            if let Some(gui) = lmstudio_gui_exe() {
                let mut g = Command::new(&gui);
                #[cfg(target_os = "windows")]
                g.creation_flags(CREATE_NO_WINDOW);
                let _ = g.spawn();
            }

            // Wait up to 30 s for ~/.lmstudio/ to appear. The first GUI launch
            // typically writes this within 3–8 s, but on a slow VM 30 s is a
            // safer ceiling than failing the install.
            let lmstudio_dir = dirs::home_dir().map(|h| h.join(".lmstudio"));
            for _ in 0..30 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if let Some(d) = &lmstudio_dir {
                    if d.exists() {
                        break;
                    }
                }
            }

            // Retry bootstrap from the (now possibly different) lms.exe.
            // After GUI launch the .lmstudio dir might already contain a
            // launcher; if not, the pre-bootstrap path is still valid.
            if let Some(p) = lmstudio_lms_path() {
                let mut bs = Command::new(&p);
                bs.arg("bootstrap");
                #[cfg(target_os = "windows")]
                bs.creation_flags(CREATE_NO_WINDOW);
                let _ = bs.output();
            }
        }

        // Start the embedded server. `lms server start` is non-blocking — it
        // detaches a background httpd. --cors so LU's web view (which is on a
        // tauri:// origin) isn't blocked by the SOP. Port matches the
        // provider-store default of 1234 so user config Just Works.
        // Re-resolve the path because the bootstrap dance above may have
        // promoted us from the pre-bootstrap path to ~/.lmstudio/bin/lms.exe.
        update("starting", "Starting LM Studio server on port 1234...");
        if let Some(p) = lmstudio_lms_path() {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            let _ = srv.spawn();
        }

        // Wait for the server to respond. LM Studio's server typically takes
        // ~3-5 s to bind in a fresh install (it loads its model index first).
        update("starting", "Waiting for LM Studio server...");
        let mut ready = false;
        for i in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if lmstudio_server_running() {
                ready = true;
                break;
            }
            println!("[LMStudio] Server not ready, attempt {}/15", i + 1);
        }

        if ready {
            update("complete", "LM Studio server is up on localhost:1234.");
        } else {
            update(
                "error",
                "LM Studio installed but the server didn't come up. Open LM Studio from the Start menu and toggle the Server tab on, then click Re-Scan.",
            );
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

#[tauri::command]
pub fn install_lmstudio_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.lmstudio_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Best-effort: spawn `lms server start` so we don't make the user open the
/// LM Studio GUI just to flip the Server toggle. Idempotent — quick early-exit
/// if the server is already responding.
#[tauri::command]
pub fn start_lmstudio_server() -> Result<serde_json::Value, String> {
    if lmstudio_server_running() {
        return Ok(serde_json::json!({"status": "already_running"}));
    }
    match lmstudio_lms_path() {
        Some(p) => {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            srv.spawn()
                .map_err(|e| format!("spawn lms: {}", e))?;
            Ok(serde_json::json!({"status": "starting"}))
        }
        None => Err(
            "LM Studio is not installed (no lms.exe found). Use Settings → Install LM Studio first."
                .to_string(),
        ),
    }
}

// ASYNC + spawn_blocking: this command does a (now-bounded) blocking TCP/HTTP
// probe + filesystem scan. A SYNCHRONOUS Tauri command runs on the MAIN thread,
// so the model-selector's on-open + 1.5 s poll froze the UI. Running the
// blocking body on the blocking pool keeps the webview responsive even if a
// probe is slow. (reqwest::blocking also panics inside an async runtime, so the
// blocking work MUST live in spawn_blocking, not a bare async body.)
#[tauri::command]
pub async fn lmstudio_server_status() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| -> Result<serde_json::Value, String> {
        let model_count = lmstudio_models_present();
        Ok(serde_json::json!({
            "running": lmstudio_server_running(),
            "port": LMSTUDIO_DEFAULT_PORT,
            "lms_present": lmstudio_lms_path().is_some(),
            // Soft-detect signals — onboarding shows "Start LM Studio server?"
            // when models are present even if lms.exe couldn't be located.
            "models_detected": model_count > 0,
            "model_count": model_count,
        }))
    })
    .await
    .map_err(|e| format!("lmstudio_server_status task: {e}"))?
}

// ── Per-model load / unload ────────────────────────────────────
//
// LM Studio's HTTP API has no load/unload endpoints; we drive the `lms`
// CLI for state changes and read the list of loaded models from the v0
// REST API (`/api/v0/models` returns each entry with `state: "loaded" |
// "not-loaded"`). This mirrors the Ollama per-row toggle in the model
// selector — without it LM-Studio rows have no on/off affordance even
// though the underlying engine does the same load-into-VRAM dance.
//
// Backport from uselu E2E pass (2026-05-19). Body is 1:1; signature
// adapted from uselu's bridge-daemon convention to Tauri command, and
// the lms-CLI lookup uses desktop's richer `lmstudio_lms_path()` helper
// instead of uselu's lighter `os_paths::find_lms_cli()`.

// ASYNC + spawn_blocking + fast port pre-check (see lmstudio_server_status /
// lmstudio_port_open). Polled every ~1.5 s by the model selector while open —
// the old sync + slow-localhost-probe form was the main cause of the dropdown
// freeze.
#[tauri::command]
pub async fn lmstudio_list_loaded() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| -> Result<serde_json::Value, String> {
        let empty = || serde_json::json!({ "loaded": Vec::<String>::new() });
        // Down server → return empty in <=300 ms instead of a 2–7 s connect.
        if !lmstudio_port_open() {
            return Ok(empty());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .connect_timeout(std::time::Duration::from_millis(400))
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("http://127.0.0.1:{}/api/v0/models", LMSTUDIO_DEFAULT_PORT);
        let resp = match client.get(&url).send() {
            Ok(r) => r,
            Err(_) => return Ok(empty()),
        };
        if !resp.status().is_success() {
            return Ok(empty());
        }
        let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let loaded: Vec<String> = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|m| m.get("state").and_then(|s| s.as_str()) == Some("loaded"))
                    .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(serde_json::json!({ "loaded": loaded }))
    })
    .await
    .map_err(|e| format!("lmstudio_list_loaded task: {e}"))?
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn lmstudio_load_model(model: String, contextLength: Option<u32>) -> Result<serde_json::Value, String> {
    let lms = lmstudio_lms_path()
        .ok_or_else(|| "lms CLI not found — install LM Studio first".to_string())?;
    // `lms load` blocks until the model is in memory. The caller is expected
    // to render a spinner while the request is in flight (same pattern as
    // the Ollama per-row toggle).
    //
    // `-y` / --yes is REQUIRED here, not optional: per `lms load --help`, when
    // the model key is ambiguous (multiple quant/variant matches) or the CLI
    // wants to confirm a device, `lms load` drops into an INTERACTIVE picker
    // that reads from stdin. We capture output with no stdin attached, so that
    // picker blocks forever — the command never returns and the model-selector
    // spinner hangs indefinitely with no error surfaced (observed live on
    // 2026-06-01 with qwen2.5-0.5b-instruct@q4_k_m). `-y` auto-approves and
    // loads the first/preferred match, which is exactly the scripted behaviour
    // we want. Verified: `lms load -y <key>` returns in ~4s and `lms ps` shows
    // the model loaded.
    //
    // contextLength: LM Studio fixes the context window at LOAD time (the
    // OpenAI-compat HTTP API has no per-request num_ctx). To CHANGE it we must
    // reload — so when a context length is requested we unload the current
    // instance first (best-effort; a no-op if nothing is loaded) and reload
    // with `-c <N>` (`lms load --context-length`). Without a context length
    // this stays a plain load (the B3 power toggle path, unchanged).
    if contextLength.is_some() {
        // Hide the console window the `lms` CLI would otherwise flash on
        // Windows (CREATE_NO_WINDOW) — these run during normal model
        // switching / the VRAM hand-off, not just at install time.
        let mut unload = Command::new(&lms);
        unload.args(["unload", &model]);
        #[cfg(target_os = "windows")]
        unload.creation_flags(CREATE_NO_WINDOW);
        let _ = unload.output();
    }
    let ctx = contextLength.unwrap_or(0);
    let ctx_str = ctx.to_string();
    let mut args: Vec<&str> = vec!["load", model.as_str(), "-y"];
    if ctx > 0 {
        args.push("-c");
        args.push(ctx_str.as_str());
    }
    let mut cmd = Command::new(&lms);
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("spawn lms load: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!(
            "[lmstudio_load_model] FAILED model='{}' ctx={:?} code={:?}\n  stderr={:?}\n  stdout={:?}",
            model,
            contextLength,
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        );
        return Err(format!("lms load failed: {}", stderr.trim()));
    }
    eprintln!("[lmstudio_load_model] OK model='{}' ctx={:?}", model, contextLength);
    Ok(serde_json::json!({ "ok": true, "model": model, "contextLength": contextLength }))
}

/// Read a model's context window from LM Studio's enhanced REST API
/// (`GET /api/v0/models`). Returns `loaded_context_length` (what the model is
/// ACTUALLY running with right now — the value the chat truly uses) and
/// `max_context_length` (the model's ceiling). Both are null when LM Studio
/// isn't running or the model isn't found. Reading the list endpoint (not the
/// per-id one) sidesteps URL-encoding issues with publisher/slash ids.
// ASYNC + spawn_blocking + fast port pre-check — same freeze class as
// lmstudio_list_loaded; this one feeds the header token counter.
#[tauri::command]
pub async fn lmstudio_model_context(model: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let null_json = || serde_json::json!({ "loaded": serde_json::Value::Null, "max": serde_json::Value::Null, "state": serde_json::Value::Null });
        if !lmstudio_port_open() {
            return Ok(null_json());
        }
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(2000))
            .connect_timeout(std::time::Duration::from_millis(400))
            .no_proxy()
            .build()
        {
            Ok(c) => c,
            Err(_) => return Ok(null_json()),
        };
        let url = format!("http://127.0.0.1:{}/api/v0/models", LMSTUDIO_DEFAULT_PORT);
        let resp = match client.get(&url).send() {
            Ok(r) => r,
            Err(_) => return Ok(null_json()),
        };
        if !resp.status().is_success() {
            return Ok(null_json());
        }
        let body: serde_json::Value = match resp.json() {
            Ok(b) => b,
            Err(_) => return Ok(null_json()),
        };
        let entry = body
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.iter().find(|m| m.get("id").and_then(|i| i.as_str()) == Some(model.as_str())));
        match entry {
            Some(m) => {
                let loaded = m.get("loaded_context_length").and_then(|v| v.as_u64());
                let max = m
                    .get("max_context_length")
                    .and_then(|v| v.as_u64())
                    .or_else(|| m.get("context_length").and_then(|v| v.as_u64()));
                let state = m.get("state").and_then(|v| v.as_str());
                Ok(serde_json::json!({ "loaded": loaded, "max": max, "state": state }))
            }
            None => Ok(null_json()),
        }
    })
    .await
    .map_err(|e| format!("lmstudio_model_context task: {e}"))?
}

#[tauri::command]
pub fn lmstudio_unload_model(model: String) -> Result<serde_json::Value, String> {
    let lms = lmstudio_lms_path()
        .ok_or_else(|| "lms CLI not found".to_string())?;
    let mut cmd = Command::new(&lms);
    cmd.args(["unload", &model]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("spawn lms unload: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "lms unload failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(serde_json::json!({ "ok": true, "model": model }))
}

// ── Python Auto-Install (P14: Plug-and-Play, blocking pre-req for ComfyUI) ──
//
// On a fresh Windows box `python.exe` is the Microsoft Store stub at
// `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` — it prints "Python was
// not found, run without arguments to install from the Microsoft Store" and
// exits 1. That kills `pip install torch ...` 200 ms in, leaves a half-cloned
// ComfyUI dir on disk, and the user sees "ComfyUI not responding". The
// only Plug-and-Play fix for newbies is to install Python ourselves; this is
// what `install_python` does. Same shape as `install_ollama` /
// `install_lmstudio`: kick off a background thread, surface status via a
// shared `InstallState`, and re-resolve `python_bin` once it finishes so
// subsequent `install_comfyui` calls find it without an app restart.

#[tauri::command]
pub fn install_python(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // If Python is already there, short-circuit so the UI can skip the
    // install card and go straight to ComfyUI. is_real_python rejects
    // the empty sentinel and WindowsApps stub paths.
    {
        let current = state.python_bin.lock().unwrap().clone();
        if crate::python::is_real_python(&current) {
            return Ok(serde_json::json!({"status": "already_installed", "path": current}));
        }
    }

    let mut install = state.python_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Installing Python 3.12 via winget (~30 MB)…".to_string());
    drop(install);

    info!("python install start");

    let py_state = state.python_install.clone();
    let py_bin_slot = state.python_bin.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = py_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Bug I (discovered during 2026-05-17 Arch live test): pre-fix
        // install_python unconditionally invoked `winget` which is
        // Windows-exclusive. On Linux that fails with "winget: command
        // not found" and the user gets stuck. In practice every modern
        // Linux distro ships Python in the base group so the install
        // button rarely needs to fire — but when it does, surfacing the
        // right distro-specific install command beats a cryptic spawn
        // error.
        #[cfg(target_os = "linux")]
        {
            let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
            let suggestion = linux_python_install_hint(&os_release);
            update(
                "error",
                &format!(
                    "Python isn't installed system-wide. On Linux, install it via {} \
                     then click Re-detect. (LU's auto-installer is Windows-only — on \
                     Linux your package manager is the right tool.)",
                    suggestion
                ),
            );
            return;
        }
        #[cfg(target_os = "macos")]
        {
            update(
                "error",
                "Python isn't installed system-wide. On macOS, install it via \
                 `brew install python` (Homebrew) or download Python 3.12+ from \
                 https://www.python.org/downloads/macos/ then click Re-detect.",
            );
            return;
        }

        // Stream-friendly winget invocation. `--silent --accept-*-agreements`
        // drops the EULA prompts; without them winget will sit and wait for
        // user input forever inside our background thread. Python.Python.3.12
        // is the canonical winget id for the python.org installer (matches
        // `winget search python` top result).
        update("installing", "Running: winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements");

        let mut cmd = Command::new("winget");
        cmd.args([
            "install",
            "Python.Python.3.12",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--scope",
            "user",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                update(
                    "error",
                    &format!(
                        "Could not run winget: {}. winget ships with Windows 10/11 — \
                         if it's missing, run 'Get App Installer' from the Microsoft \
                         Store (free) and retry.",
                        e
                    ),
                );
                return;
            }
        };

        // Stream stdout + stderr line-by-line so the UI's log card animates
        // as winget extracts and installs (otherwise it freezes for 1–2 min).
        let mut child = child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_state = py_state.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stdout_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });
        let stderr_state = py_state.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stderr_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        let exit_status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                update("error", &format!("winget wait failed: {}", e));
                return;
            }
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        if !exit_status.success() {
            // winget exit codes are HRESULT-shaped; -1978335189 (0x8A150011)
            // means "no upgrade applicable" which is fine if Python is
            // already present. Anything else is a real failure.
            let code = exit_status.code().unwrap_or(-1);
            // Re-resolve regardless: Python may already be on the box from
            // a previous install attempt that the original where-scan
            // missed (e.g. Add-to-PATH was unchecked).
            let resolved = crate::python::get_python_bin();
            if crate::python::is_real_python(&resolved) {
                if let Ok(mut slot) = py_bin_slot.lock() {
                    *slot = resolved.clone();
                }
                update(
                    "complete",
                    &format!("Python ready (winget exit {} ignored, Python detected at {})", code, resolved),
                );
                return;
            }
            update(
                "error",
                &format!(
                    "winget exited with code {}. Python was not detected after \
                     install. Try installing manually from python.org with the \
                     'Add Python to PATH' checkbox on, then return here and \
                     click Re-Scan.",
                    code
                ),
            );
            return;
        }

        update("starting", "winget finished. Re-resolving Python…");

        // Give the freshly installed Python a moment to settle (winget can
        // signal completion before the file is fully linked into PATH on
        // some boxes), then re-resolve and persist.
        for attempt in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let resolved = crate::python::get_python_bin();
            if crate::python::is_real_python(&resolved) {
                if let Ok(mut slot) = py_bin_slot.lock() {
                    *slot = resolved.clone();
                }
                update(
                    "complete",
                    &format!("Python ready at {}", resolved),
                );
                return;
            }
            println!("[Python] post-install resolve attempt {}/15 — not yet on PATH", attempt + 1);
        }

        update(
            "error",
            "winget reported success but Python is still not on PATH. \
             Restart Locally Uncensored — sometimes Windows needs the new PATH \
             to take effect. If it still doesn't show up, install manually \
             from python.org with 'Add Python to PATH' on.",
        );
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_python_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.python_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Cheap synchronous probe: is there a real Python on the box?  The frontend
/// calls this before kicking off `install_comfyui` so it can decide whether
/// to show the Python install step first. Returns the resolved path on
/// success so the UI can display it ("Found Python at C:\\…").
#[tauri::command]
pub fn python_check(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let current = state.python_bin.lock().unwrap().clone();
    if crate::python::is_real_python(&current) {
        return Ok(serde_json::json!({"available": true, "path": current}));
    }

    // The slot may have been empty at startup (fresh box) and Python may
    // have been installed since (e.g. via this same install_python flow on
    // another launch). Re-resolve as a refresh.
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
        Ok(serde_json::json!({"available": true, "path": resolved}))
    } else {
        Ok(serde_json::json!({"available": false, "path": null}))
    }
}

// ── Whisper (faster-whisper) installer (§24.9 — STT install affordance) ──────

/// The pip args to install faster-whisper. Extracted as a pure helper so the
/// exact invocation is unit-testable (and so the package name lives in one
/// place — the STT backend `whisper_server.py` imports `faster_whisper`, so
/// that's what we install). Mirrors the flags the ComfyUI installer uses:
/// `--no-input` (never block on a prompt) and `--progress-bar off` (the live
/// pip bars are noise in our log stream).
fn build_whisper_pip_args() -> Vec<&'static str> {
    vec![
        "-m", "pip", "install",
        "--progress-bar", "off",
        "--no-input",
        "faster-whisper",
    ]
}

/// §24.9 — Install faster-whisper so STT works, then start the persistent
/// whisper server so the Settings STT badge flips ✗ → ✓ without a restart.
///
/// Installs into the SAME Python the rest of LU's Python tooling uses: the
/// ComfyUI venv when one exists (matches `install_custom_node` /
/// `start_comfyui`), else the resolved system Python. The whisper server is
/// then started with that exact interpreter — critical, because starting it
/// with a different Python than we installed into would fail the
/// `import faster_whisper` check and leave the badge red.
#[tauri::command]
pub fn install_whisper(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    {
        let mut install = state.whisper_install.lock().unwrap();
        if install.status == "installing" {
            return Ok(serde_json::json!({"status": "already_installing"}));
        }
        install.status = "installing".to_string();
        install.logs.clear();
        install.logs.push("Starting faster-whisper installation...".to_string());
    }

    info!("whisper install start");

    // Resolve the target Python: ComfyUI venv (if present) → system Python,
    // re-resolving a stale cache (Bug B8 — Python installed after launch).
    let target_python = resolve_lu_python(state.inner());

    if target_python.is_empty() || !crate::python::is_real_python(&target_python) {
        let mut install = state.whisper_install.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "No Python found. Install Python first (Settings → ComfyUI → Install Python), \
             then retry the Whisper install."
                .to_string(),
        );
        error!("whisper install aborted: no usable python");
        return Err("no_python: Python must be installed before faster-whisper.".to_string());
    }

    let install_state = state.whisper_install.clone();
    let whisper = state.whisper.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        update("installing", &format!("Installing faster-whisper via {} (this can take a few minutes)…", target_python));

        let args = build_whisper_pip_args();
        // No cancel flag — this single pip install is short relative to the
        // ComfyUI PyTorch download, so we run it to completion like install_python.
        match pip_install_streaming_with_retry_cancellable(&args, &target_python, 3, &install_state, None) {
            Ok(()) => {
                update("installing", "faster-whisper installed. Starting the speech-to-text server…");
                // Start the persistent server with the SAME Python we installed
                // into, so the import check passes and whisper_status flips to
                // available without an app restart. auto_start_whisper_sync
                // re-checks `import faster_whisper` and locates whisper_server.py
                // from bundled resources (prod) or ./public (dev).
                {
                    let already_running = whisper.lock().map(|w| w.ready).unwrap_or(false);
                    if !already_running {
                        crate::commands::whisper::auto_start_whisper_sync(&app, &target_python, &whisper);
                    }
                }
                let started = whisper.lock().map(|w| w.ready).unwrap_or(false);
                if started {
                    update("complete", "Speech-to-text is ready.");
                } else {
                    // Install succeeded but the server didn't come up (e.g. model
                    // download still pending). Still a success for the install
                    // itself — the badge re-check / next launch will pick it up.
                    update("complete", "faster-whisper installed. The STT server will finish loading shortly (or on next launch).");
                }
            }
            Err(diagnosis) => {
                let err = format!("faster-whisper installation failed.\n\n{}", diagnosis);
                println!("[Whisper Install] {}", err);
                update("error", &err);
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// §24.9 — Poll the faster-whisper install progress (mirrors the other
/// `*_status` commands). The frontend re-runs `checkWhisperAvailable` when
/// this reports `complete`.
#[tauri::command]
pub fn install_whisper_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.whisper_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ── Piper neural TTS installer (David 2026-06-06 — local neural TTS) ──────────

/// Resolve the Python LU's tooling uses: the ComfyUI venv when present, else
/// the resolved system Python. Shared by the faster-whisper + Piper-TTS
/// installers and the TTS synthesizer so they all target the same interpreter.
pub fn resolve_lu_python(state: &AppState) -> String {
    let comfy_dir: Option<PathBuf> = {
        let p = state.comfy_path.lock().unwrap().clone();
        p.map(PathBuf::from)
            .or_else(|| crate::commands::process::find_comfyui_path().map(PathBuf::from))
    };
    let venv_python = comfy_dir
        .as_deref()
        .and_then(crate::python::resolve_comfyui_venv_python);
    if let Some(v) = venv_python {
        return v;
    }
    // System Python: use the cached resolution, but if it's empty/stale —
    // Python may have been installed AFTER launch (Bug B8) — re-resolve once and
    // refresh the cache so install_tts/install_whisper don't wrongly report "no
    // Python found" until the next restart.
    let cached = state.python_bin.lock().map(|g| g.clone()).unwrap_or_default();
    if crate::python::is_real_python(&cached) {
        return cached;
    }
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
    }
    resolved
}

/// pip args to install Piper TTS. `piper-tts` ships the `piper` CLI + the
/// `piper.download_voices` helper. Same flags as the whisper installer.
fn build_tts_pip_args() -> Vec<&'static str> {
    vec![
        "-m", "pip", "install",
        "--progress-bar", "off",
        "--no-input",
        "piper-tts",
    ]
}

/// Install Piper (neural TTS) into LU's Python, then download the default voice
/// model into `<app_data>/piper_voices/`. Mirrors `install_whisper`. Progress
/// is polled via `install_tts_status`; `tts_status` reports usability.
#[tauri::command]
pub fn install_tts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    {
        let mut install = state.tts_install.lock().unwrap();
        if install.status == "installing" {
            return Ok(serde_json::json!({"status": "already_installing"}));
        }
        install.status = "installing".to_string();
        install.logs.clear();
        install.logs.push("Starting neural TTS (Piper) installation...".to_string());
    }

    info!("tts install start");

    let target_python = resolve_lu_python(state.inner());
    if target_python.is_empty() || !crate::python::is_real_python(&target_python) {
        let mut install = state.tts_install.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "No Python found. Install Python first (Settings → ComfyUI → Install Python), \
             then retry the neural TTS install."
                .to_string(),
        );
        error!("tts install aborted: no usable python");
        return Err("no_python: Python must be installed before Piper TTS.".to_string());
    }

    let voices_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", e))?
        .join("piper_voices");

    let install_state = state.tts_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        update(
            "installing",
            &format!("Installing piper-tts via {} (this can take a few minutes)…", target_python),
        );

        let args = build_tts_pip_args();
        match pip_install_streaming_with_retry_cancellable(&args, &target_python, 3, &install_state, None) {
            Ok(()) => {
                update(
                    "installing",
                    &format!(
                        "piper-tts installed. Downloading the {} voice (~63 MB)…",
                        crate::commands::tts::PIPER_VOICE
                    ),
                );
                let _ = std::fs::create_dir_all(&voices_dir);
                let mut cmd = Command::new(&target_python);
                cmd.args([
                    "-m",
                    "piper.download_voices",
                    crate::commands::tts::PIPER_VOICE,
                    "--download-dir",
                    &voices_dir.to_string_lossy(),
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                cmd.creation_flags(CREATE_NO_WINDOW);
                match cmd.output() {
                    Ok(o) if o.status.success() => {
                        update("complete", "Neural TTS is ready.");
                    }
                    Ok(o) => {
                        update(
                            "error",
                            &format!("Voice download failed:\n{}", String::from_utf8_lossy(&o.stderr)),
                        );
                    }
                    Err(e) => {
                        update("error", &format!("Voice download could not start: {}", e));
                    }
                }
            }
            Err(diagnosis) => {
                let err = format!("piper-tts installation failed.\n\n{}", diagnosis);
                println!("[TTS Install] {}", err);
                update("error", &err);
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// Poll the Piper-TTS install progress (mirrors `install_whisper_status`).
#[tauri::command]
pub fn install_tts_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.tts_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
    }))
}

// ──────────────────────────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn install_custom_node(
    state: State<'_, AppState>,
    repoUrl: String,
    nodeName: String,
) -> Result<serde_json::Value, String> {
    let repo_url = repoUrl;
    let node_name = nodeName;
    info!(node = %node_name, "custom node install start");
    // Find ComfyUI path from state
    let comfy_path = {
        let path = state.comfy_path.lock().unwrap();
        path.clone()
    };

    let comfy_dir = match comfy_path {
        Some(p) => PathBuf::from(p),
        None => {
            // Try to find it
            match crate::commands::process::find_comfyui_path() {
                Some(p) => PathBuf::from(p),
                None => {
                    error!(node = %node_name, "custom node install failed: comfyui not found");
                    return Err("ComfyUI not found. Install ComfyUI first.".to_string());
                }
            }
        }
    };

    let custom_nodes_dir = comfy_dir.join("custom_nodes");
    let target_dir = custom_nodes_dir.join(&node_name);

    // Create custom_nodes dir if it doesn't exist
    if !custom_nodes_dir.exists() {
        fs::create_dir_all(&custom_nodes_dir)
            .map_err(|e| format!("Failed to create custom_nodes directory: {}", e))?;
    }

    // Bug N — same git probe as install_comfyui. Block on missing git, log
    // a soft hint when a non-native git is first on PATH.
    #[cfg(target_os = "windows")]
    {
        let probe = windows_git_probe();
        if probe == WindowsGitState::Missing {
            return Err(windows_git_install_hint(&probe).unwrap_or_default());
        }
        if probe == WindowsGitState::NonNative {
            if let Some(hint) = windows_git_install_hint(&probe) {
                println!("[Install] {}", hint);
            }
        }
    }

    if target_dir.exists() {
        // Already exists — git pull to update
        println!("[Install] Custom node {} already exists, updating...", node_name);
        let mut cmd = Command::new("git");
        cmd.args(["pull"]).current_dir(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git pull failed: {}", e))?;

        let status = if output.status.success() { "updated" } else { "update_failed" };
        Ok(serde_json::json!({
            "status": status,
            "path": target_dir.to_string_lossy(),
        }))
    } else {
        // Clone the repo
        println!("[Install] Cloning custom node {} from {}", node_name, repo_url);
        let mut cmd = Command::new("git");
        cmd.args(["clone", &repo_url]).arg(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if output.status.success() {
            // Install requirements.txt if it exists
            let reqs = target_dir.join("requirements.txt");
            if reqs.exists() {
                // Bug F (discovered during Arch live test on 2026-05-17):
                // ComfyUI was installed into a venv by the Bug E path, but
                // this function used to call pip against `state.python_bin`
                // (the system Python). On Arch / Debian 12+ / Fedora 38+
                // that hits PEP 668's `externally-managed-environment` and
                // the requirements install silently fails (`let _ = pip.output()`
                // ignored the exit code, so the user got "installed" even
                // when requirements never landed — the next workflow build
                // would then crash with `ModuleNotFoundError`).
                //
                // Fix: prefer the ComfyUI venv's Python (matches the launcher
                // in `process.rs::start_comfyui` and the installer in
                // `install_comfyui`) so requirements land in the same
                // site-packages ComfyUI actually imports from. Plus we now
                // surface a useful error when pip fails instead of swallowing it.
                let venv_python = crate::python::resolve_comfyui_venv_python(&comfy_dir);
                let python_bin = venv_python.unwrap_or_else(|| {
                    state.python_bin.lock().unwrap().clone()
                });
                if python_bin.is_empty() {
                    return Err(format!(
                        "Custom node {} cloned, but cannot install requirements: \
                         no Python available. Install Python first \
                         (Settings → ComfyUI → Install Python).",
                        node_name
                    ));
                }
                println!("[Install] Installing requirements for {} via {}", node_name, python_bin);
                let mut pip = Command::new(&python_bin);
                pip.args(["-m", "pip", "install", "--no-input", "-r"]).arg(&reqs)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pip.creation_flags(CREATE_NO_WINDOW);
                let pip_out = pip.output()
                    .map_err(|e| format!("Failed to spawn pip for {} requirements: {}", node_name, e))?;
                if !pip_out.status.success() {
                    let stderr = String::from_utf8_lossy(&pip_out.stderr);
                    let stdout = String::from_utf8_lossy(&pip_out.stdout);
                    let combined = format!("{}{}", stdout, stderr);
                    // Reuse the install_comfyui diagnose path so PEP 668 +
                    // friends produce actionable messages here too.
                    let diagnosis = diagnose_pip_error(&combined);
                    error!(node = %node_name, "custom node requirements install failed");
                    return Err(format!(
                        "Custom node {} cloned, but requirements install failed.\n\n{}",
                        node_name, diagnosis
                    ));
                }
            }

            Ok(serde_json::json!({
                "status": "installed",
                "path": target_dir.to_string_lossy(),
            }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(node = %node_name, "custom node clone failed");
            Err(format!("Failed to clone {}: {}", node_name, stderr))
        }
    }
}

// ── tests (issue #32: PyTorch / ComfyUI install reliability) ────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_transient_pip_error ────────────────────────────────────────────

    #[test]
    fn transient_detects_403() {
        assert!(is_transient_pip_error(
            "ERROR: HTTP error 403 while getting https://files.pythonhosted.org/packages/.../torch.whl"
        ));
    }

    #[test]
    fn transient_detects_502() {
        assert!(is_transient_pip_error(
            "WARNING: Retrying after connection broken by 'NewConnectionError: 502 Bad Gateway'"
        ));
    }

    #[test]
    fn transient_detects_503() {
        assert!(is_transient_pip_error(
            "HTTP 503 service unavailable from pypi"
        ));
    }

    #[test]
    fn transient_detects_429_rate_limit() {
        assert!(is_transient_pip_error(
            "ERROR: 429 Too Many Requests"
        ));
    }

    #[test]
    fn transient_detects_ssl_error() {
        assert!(is_transient_pip_error(
            "SSLError(SSLZeroReturnError(...)) caused TLS handshake failure"
        ));
    }

    #[test]
    fn transient_detects_read_timeout() {
        assert!(is_transient_pip_error(
            "ReadTimeoutError(HTTPSConnectionPool(host='pypi.org', port=443): Read timed out.)"
        ));
    }

    #[test]
    fn transient_detects_connect_timeout() {
        assert!(is_transient_pip_error(
            "ConnectTimeoutError reaching pypi.org"
        ));
    }

    #[test]
    fn transient_detects_connection_reset() {
        assert!(is_transient_pip_error(
            "ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host', None, 10054, None)"
        ));
    }

    #[test]
    fn transient_detects_connection_aborted() {
        assert!(is_transient_pip_error(
            "ConnectionError: ('Connection aborted.', RemoteDisconnected(...))"
        ));
    }

    #[test]
    fn transient_detects_connection_refused() {
        assert!(is_transient_pip_error(
            "ConnectionRefusedError: [Errno 111] Connection refused"
        ));
    }

    #[test]
    fn transient_detects_incomplete_read() {
        assert!(is_transient_pip_error(
            "IncompleteRead(0 bytes read, 1024 more expected)"
        ));
    }

    #[test]
    fn transient_detects_max_retries() {
        assert!(is_transient_pip_error(
            "Max retries exceeded with url: /packages/torch.whl"
        ));
    }

    #[test]
    fn transient_rejects_permission_error() {
        assert!(!is_transient_pip_error(
            "PermissionError: [Errno 13] Permission denied: 'C:\\\\Python\\\\Lib\\\\site-packages\\\\torch'"
        ));
    }

    #[test]
    fn transient_rejects_no_module_error() {
        assert!(!is_transient_pip_error(
            "ModuleNotFoundError: No module named 'pip'"
        ));
    }

    #[test]
    fn transient_rejects_disk_full() {
        assert!(!is_transient_pip_error(
            "OSError: [Errno 28] No space left on device"
        ));
    }

    #[test]
    fn transient_rejects_no_matching_distribution() {
        assert!(!is_transient_pip_error(
            "ERROR: Could not find a version that satisfies the requirement torch (from versions: none)"
        ));
    }

    #[test]
    fn transient_rejects_404_missing_package() {
        // 404 means the file genuinely doesn't exist — retry won't help.
        assert!(!is_transient_pip_error(
            "ERROR: HTTP error 404 while getting nonexistent-package.whl"
        ));
    }

    // ── diagnose_pip_error ────────────────────────────────────────────────

    #[test]
    fn diagnose_ssl_includes_antivirus_hint() {
        let msg = diagnose_pip_error("SSLError(SSLZeroReturnError(...))");
        let lower = msg.to_lowercase();
        assert!(lower.contains("antivirus") || lower.contains("firewall") || lower.contains("clock"));
    }

    #[test]
    fn diagnose_403_suggests_vpn() {
        let msg = diagnose_pip_error("HTTP 403 from pytorch.org");
        let lower = msg.to_lowercase();
        assert!(lower.contains("vpn") || lower.contains("network") || lower.contains("blocked"));
    }

    #[test]
    fn diagnose_429_mentions_rate_limit() {
        let msg = diagnose_pip_error("HTTP 429 Too Many Requests");
        assert!(msg.to_lowercase().contains("rate limit"));
    }

    #[test]
    fn diagnose_disk_full_mentions_space() {
        let msg = diagnose_pip_error("OSError: [Errno 28] No space left on device");
        assert!(msg.to_lowercase().contains("disk") || msg.to_lowercase().contains("space"));
    }

    #[test]
    fn diagnose_permission_suggests_close_python() {
        let msg = diagnose_pip_error("PermissionError: [Errno 13] Permission denied");
        let lower = msg.to_lowercase();
        assert!(lower.contains("permission") && (lower.contains("python") || lower.contains("close") || lower.contains("ide")));
    }

    #[test]
    fn diagnose_no_module_suggests_python_reinstall() {
        let msg = diagnose_pip_error("ModuleNotFoundError: No module named 'pip'");
        let lower = msg.to_lowercase();
        assert!(lower.contains("python") && (lower.contains("reinstall") || lower.contains("3.10")));
    }

    #[test]
    fn diagnose_no_matching_version_suggests_python_version() {
        let msg = diagnose_pip_error("ERROR: Could not find a version that satisfies the requirement torch");
        let lower = msg.to_lowercase();
        assert!(lower.contains("python") || lower.contains("version") || lower.contains("3.10"));
    }

    #[test]
    fn diagnose_unknown_error_falls_through_to_snippet() {
        let raw = "some_completely_random_error_we_haven_t_categorized";
        let msg = diagnose_pip_error(raw);
        assert!(msg.contains(raw));
    }

    #[test]
    fn diagnose_truncates_giant_stderr_to_400_chars_snippet_block() {
        let huge: String = "x".repeat(2000);
        let raw = format!("SSLError: {}", huge);
        let msg = diagnose_pip_error(&raw);
        // Snippet portion is bounded to 400 chars; full message includes hint + label
        // so it should be much shorter than the raw 2000-char input.
        assert!(msg.len() < 1200, "diagnose output was {} chars", msg.len());
    }

    // ── push_install_log ──────────────────────────────────────────────────

    #[test]
    fn push_install_log_appends_to_logs() {
        let state = Arc::new(Mutex::new(InstallState::default()));
        push_install_log(&state, "first");
        push_install_log(&state, "second");
        let s = state.lock().unwrap();
        assert_eq!(s.logs, vec!["first", "second"]);
    }

    #[test]
    fn push_install_log_does_not_clobber_status() {
        let state = Arc::new(Mutex::new(InstallState::default()));
        {
            let mut s = state.lock().unwrap();
            s.status = "installing".to_string();
        }
        push_install_log(&state, "log line");
        let s = state.lock().unwrap();
        assert_eq!(s.status, "installing");
        assert_eq!(s.logs, vec!["log line"]);
    }

    // ── parse_compute_cap_output (Bug #10 — Blackwell PyTorch routing) ────

    #[test]
    fn compute_cap_parses_ampere_single_gpu() {
        assert_eq!(parse_compute_cap_output("8.6\n"), Some(8));
    }

    #[test]
    fn compute_cap_parses_ada_single_gpu() {
        assert_eq!(parse_compute_cap_output("8.9\n"), Some(8));
    }

    #[test]
    fn compute_cap_parses_hopper() {
        assert_eq!(parse_compute_cap_output("9.0\n"), Some(9));
    }

    #[test]
    fn compute_cap_parses_blackwell() {
        assert_eq!(parse_compute_cap_output("12.0\n"), Some(12));
    }

    #[test]
    fn compute_cap_multi_gpu_picks_highest() {
        assert_eq!(parse_compute_cap_output("8.6\n12.0\n"), Some(12));
    }

    #[test]
    fn compute_cap_handles_blank_lines() {
        assert_eq!(parse_compute_cap_output("\n8.6\n\n"), Some(8));
    }

    #[test]
    fn compute_cap_returns_none_for_empty_output() {
        assert_eq!(parse_compute_cap_output(""), None);
    }

    #[test]
    fn compute_cap_skips_unparseable_lines() {
        assert_eq!(parse_compute_cap_output("[Not Supported]\n8.6\n"), Some(8));
    }

    // ── Bug E (rzgrozt — Arch PEP 668 externally-managed) ─────────────────
    //
    // The detection function spawns a Python subprocess, so we can't unit
    // test it without a Python install. We DO test the safety guarantees:
    // empty `python_bin` returns false (regression-safe default), and the
    // diagnose path surfaces a useful hint when the marker error reaches
    // the user despite the auto-venv path.

    #[test]
    fn is_pep668_protected_returns_false_for_empty_bin() {
        // Empty sentinel from python.rs::get_python_bin must short-circuit
        // to false so a missing Python doesn't accidentally trigger venv
        // creation (which would also fail and confuse the error chain).
        assert!(!is_pep668_protected(""));
    }

    #[test]
    fn is_pep668_protected_returns_false_for_garbage_bin() {
        // Probing a non-existent path can't crash — the function must
        // swallow the spawn error and return false so install proceeds as
        // it always did on systems that aren't PEP 668 protected.
        assert!(!is_pep668_protected("/definitely/not/a/real/python-9.99"));
    }

    #[test]
    fn diagnose_externally_managed_mentions_venv() {
        let raw = "error: externally-managed-environment\n\
                   × This environment is externally managed\n\
                   ╰─> To install Python packages system-wide, try 'pacman -S python-xyz'";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("pep 668") || lower.contains("externally") || lower.contains("venv"),
            "diagnose did not surface PEP 668 context: {}",
            msg
        );
    }

    #[test]
    fn diagnose_externally_managed_includes_distro_install_commands() {
        let raw = "error: externally-managed-environment";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        // We want at least one of the platform-specific install commands so
        // the user has something to copy-paste instead of just an error.
        assert!(
            lower.contains("pacman") || lower.contains("apt") || lower.contains("dnf"),
            "diagnose did not include a distro install command: {}",
            msg
        );
    }

    #[test]
    fn diagnose_externally_managed_alt_format_matches() {
        // The exact wording on Arch 2026 is `error: externally-managed`
        // without the `-environment` suffix — make sure the matcher covers
        // both spellings.
        let raw = "error: externally-managed (pip blocked by PEP 668)";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("pacman") || lower.contains("apt"),
            "diagnose missed the alt spelling: {}",
            msg
        );
    }

    #[test]
    fn transient_rejects_externally_managed() {
        // PEP 668 errors are deterministic — retrying without venv would
        // just loop forever. Must NOT be classified as transient.
        assert!(!is_transient_pip_error(
            "error: externally-managed-environment"
        ));
    }

    // ── Bug I — linux_python_install_hint distro detection ────────────────

    #[test]
    fn linux_hint_arch_via_id_field() {
        let release = "NAME=\"Arch Linux\"\nID=arch\nID_LIKE=archlinux\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("pacman"), "got: {}", hint);
        assert!(hint.contains("python") && hint.contains("pip"));
    }

    #[test]
    fn linux_hint_manjaro_via_id_like_arch() {
        let release = "NAME=\"Manjaro\"\nID=manjaro\nID_LIKE=arch\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("pacman"), "Manjaro should map to Arch family, got: {}", hint);
    }

    #[test]
    fn linux_hint_ubuntu_via_id_like_debian() {
        let release = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("apt"), "got: {}", hint);
        assert!(hint.contains("python3"));
    }

    #[test]
    fn linux_hint_debian_via_id() {
        let release = "NAME=\"Debian GNU/Linux\"\nID=debian\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("apt"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_fedora_via_id() {
        let release = "NAME=\"Fedora Linux\"\nID=fedora\nID_LIKE=\"fedora\"\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("dnf"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_rocky_via_id_like_rhel() {
        let release = "NAME=\"Rocky Linux\"\nID=rocky\nID_LIKE=\"rhel centos fedora\"\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("dnf"), "RHEL-family should suggest dnf, got: {}", hint);
    }

    #[test]
    fn linux_hint_opensuse_via_id_like() {
        let release = "NAME=\"openSUSE Tumbleweed\"\nID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("zypper"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_unknown_distro_falls_back() {
        let release = "NAME=\"Some Custom Distro\"\nID=mystery\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("package manager"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_empty_input_falls_back() {
        let hint = linux_python_install_hint("");
        assert!(hint.contains("package manager"));
    }

    // ── Bug G revisit — linux_ollama_install_hint distro detection ────────
    //
    // Bug G's original "auto-download raw binary" fix shipped broken because
    // Ollama removed the raw `ollama-linux-amd64` asset in late 2025 — current
    // releases ship as multi-GB tarballs with bundled CUDA libs. Auto-download
    // isn't user-friendly at that size, so we surface distro-specific install
    // commands instead. These tests pin the matrix.

    #[test]
    fn ollama_hint_arch_recommends_pacman_ollama() {
        let release = "NAME=\"Arch Linux\"\nID=arch\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("pacman -S ollama"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_manjaro_via_id_like_arch() {
        let release = "NAME=\"Manjaro\"\nID=manjaro\nID_LIKE=arch\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("pacman -S ollama"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_ubuntu_recommends_apt_or_install_sh() {
        let release = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("apt install ollama"), "got: {}", hint);
        assert!(hint.contains("install.sh"), "should also offer official installer, got: {}", hint);
    }

    #[test]
    fn ollama_hint_fedora_recommends_official_install_sh() {
        let release = "NAME=\"Fedora Linux\"\nID=fedora\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("install.sh"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_rocky_via_id_like_rhel() {
        let release = "NAME=\"Rocky Linux\"\nID=rocky\nID_LIKE=\"rhel centos fedora\"\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("install.sh"), "RHEL-family should get install.sh, got: {}", hint);
    }

    #[test]
    fn ollama_hint_opensuse_recommends_zypper_or_install_sh() {
        let release = "NAME=\"openSUSE Tumbleweed\"\nID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("zypper install ollama") || hint.contains("install.sh"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_unknown_distro_falls_back_to_install_sh() {
        let release = "NAME=\"Some Custom Distro\"\nID=mystery\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("install.sh") || hint.contains("ollama.com"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_empty_input_falls_back() {
        let hint = linux_ollama_install_hint("");
        assert!(hint.contains("install.sh") || hint.contains("ollama.com"));
    }

    // ── Bug E — LIVE integration test ──────────────────────────────────────
    //
    // Runs against a real Python install with a real EXTERNALLY-MANAGED
    // marker planted in its stdlib. Requires the caller to point
    // `LU_PEP668_TEST_PYTHON` env var at a Python whose stdlib is writable
    // (typically a temp copy of system Python — see
    // `LU-E2E-Test-Kit/scripts/pep668_live_test.ps1` for the setup helper).
    //
    // Skipped by default via `#[ignore]` because:
    // 1. needs a real, modifiable Python install (not safe to mutate the
    //    system Python's stdlib — wedges every pip command on the box).
    // 2. writes to the filesystem and spawns 4-5 Python subprocesses.
    //
    // Run with: `cargo test --release --bins -- --ignored pep668_e2e_live`

    #[test]
    #[ignore]
    fn pep668_e2e_live_detect_and_create_venv() {
        let fake_python = std::env::var("LU_PEP668_TEST_PYTHON")
            .expect("set LU_PEP668_TEST_PYTHON to the fake-python path before running");
        assert!(
            std::path::Path::new(&fake_python).exists(),
            "LU_PEP668_TEST_PYTHON does not exist: {}",
            fake_python
        );

        // The helper script must have planted the marker BEFORE this test
        // runs. If it didn't, the detection should return false — that's
        // also informative, so we don't fail outright here; we just print
        // and check the more interesting assertions.

        // ── Phase 1: PEP 668 detection ──
        let detected = is_pep668_protected(&fake_python);
        assert!(
            detected,
            "is_pep668_protected({}) returned false — was the EXTERNALLY-MANAGED \
             marker planted in this Python's stdlib?",
            fake_python
        );
        println!("[live E2E] ✓ is_pep668_protected detected the marker");

        // ── Phase 2: create_comfyui_venv ──
        let comfy_root = std::env::temp_dir().join("lu-pep668-live-comfyui");
        let _ = std::fs::remove_dir_all(&comfy_root);
        std::fs::create_dir_all(&comfy_root).expect("temp dir create");

        let venv_py = create_comfyui_venv(&comfy_root, &fake_python)
            .expect("create_comfyui_venv should succeed against fake python");

        assert!(venv_py.exists(), "venv python at {} should exist", venv_py.display());
        assert!(venv_py.starts_with(&comfy_root), "venv python should be inside comfy dir");
        println!("[live E2E] ✓ create_comfyui_venv produced {}", venv_py.display());

        // ── Phase 3: nested venv's pip should be UNBLOCKED ──
        // The venv has its own site-packages, so PEP 668 doesn't apply to
        // it — this is the whole point of the fix. Verify pip install
        // works inside the nested venv. We use `--dry-run` so we don't
        // actually download anything heavy; the test is whether pip
        // refuses or proceeds.
        let pip_out = std::process::Command::new(venv_py.to_string_lossy().as_ref())
            .args(["-m", "pip", "install", "--dry-run", "--no-input", "pip"])
            .output()
            .expect("nested venv pip should spawn");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&pip_out.stdout),
            String::from_utf8_lossy(&pip_out.stderr)
        );
        assert!(
            !combined.to_lowercase().contains("externally-managed"),
            "nested venv pip was STILL blocked — PEP 668 leaked through. \
             Output:\n{}",
            combined
        );
        assert!(pip_out.status.success(), "nested venv pip exit code != 0:\n{}", combined);
        println!("[live E2E] ✓ nested venv pip runs without PEP 668 block");

        // ── Phase 4: idempotency — second create_comfyui_venv must no-op ──
        let venv_py_again = create_comfyui_venv(&comfy_root, &fake_python)
            .expect("second create_comfyui_venv should idempotently return existing venv");
        assert_eq!(venv_py, venv_py_again);
        println!("[live E2E] ✓ create_comfyui_venv is idempotent");

        // Cleanup
        let _ = std::fs::remove_dir_all(&comfy_root);
        println!("[live E2E] ALL ASSERTIONS PASSED");
    }

    // ── Bug N — windows_git_probe classification matrix ──────────────────
    //
    // juliandiggins-stack hit a half-installed ComfyUI on Windows because a
    // WSL git on PATH ran the clone but choked on the Windows-style target
    // path. The probe is the gate that should surface a clear hint instead.
    // These tests pin the classification — the actual `git --version` call
    // is integration-only and lives in the live E2E section.

    #[test]
    fn git_probe_native_git_for_windows() {
        // Git for Windows always tags its version with `.windows.<n>`.
        let stdout = "git version 2.43.0.windows.1";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::Native);
    }

    #[test]
    fn git_probe_native_git_for_windows_recent_build() {
        // Newer Git for Windows builds keep the same tag shape.
        let stdout = "git version 2.45.2.windows.1";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::Native);
    }

    #[test]
    fn git_probe_wsl_git_is_non_native() {
        // WSL ships stock upstream git — no `.windows` tag.
        let stdout = "git version 2.43.0";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::NonNative);
    }

    #[test]
    fn git_probe_msys_git_is_non_native() {
        // MSYS2 git: also no `.windows` tag, even though it can sometimes
        // handle Windows paths. We classify as NonNative and let the user
        // decide based on the soft warning.
        let stdout = "git version 2.44.0.msys";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::NonNative);
    }

    #[test]
    fn git_probe_failed_exit_is_missing() {
        // `git --version` ran but exited non-zero (broken install).
        let state = windows_git_probe_from_output("", false);
        assert_eq!(state, WindowsGitState::Missing);
    }

    #[test]
    fn git_probe_empty_stdout_is_missing() {
        // Spawn succeeded but no output — shouldn't happen with real git.
        let state = windows_git_probe_from_output("", true);
        assert_eq!(state, WindowsGitState::Missing);
    }

    #[test]
    fn git_probe_garbage_output_is_missing() {
        // Some other binary on PATH answered to --version. Treat as missing
        // git (the user wants the *real* git, not whatever-this-is).
        let state = windows_git_probe_from_output("hello world", true);
        assert_eq!(state, WindowsGitState::Missing);
    }

    #[test]
    fn git_probe_case_insensitive_match() {
        // Defensive: real git always emits lowercase "git version", but a
        // theoretical shim could uppercase it. We lower-case before checking.
        let stdout = "GIT VERSION 2.43.0.WINDOWS.1";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::Native);
    }

    // ── windows_git_install_hint copy ─────────────────────────────────────

    #[test]
    fn git_hint_native_returns_none() {
        // Native git → no hint needed, install proceeds silently.
        assert!(windows_git_install_hint(&WindowsGitState::Native).is_none());
    }

    #[test]
    fn git_hint_missing_mentions_git_scm_download() {
        let hint = windows_git_install_hint(&WindowsGitState::Missing).unwrap();
        let lower = hint.to_lowercase();
        // Must point at the canonical install URL so users can copy-paste.
        assert!(
            lower.contains("git-scm.com/download/win"),
            "Missing hint must point at canonical Git for Windows download: {}",
            hint
        );
        // Must use the word "install" so users understand the action.
        assert!(lower.contains("install"), "got: {}", hint);
    }

    /// LIVE E2E for Bug N — only runs on real Windows hosts because
    /// `windows_git_probe` is `cfg(target_os = "windows")`. Verifies that
    /// the actual `git --version` on the build machine classifies the way
    /// we expect. On a fresh Windows tester box with Git for Windows
    /// installed (the common case), this is `Native` and silent.
    #[cfg(target_os = "windows")]
    #[test]
    fn git_probe_live_on_this_host() {
        let state = windows_git_probe();
        // We can't assert a specific variant — that depends on what's on
        // the build box. But we can assert the result is well-formed and
        // that whatever variant came back the hint is consistent.
        let hint = windows_git_install_hint(&state);
        match state {
            WindowsGitState::Native => assert!(hint.is_none(), "Native must produce no hint"),
            _ => {
                let h = hint.expect("Non-Native states must produce a hint");
                assert!(h.to_lowercase().contains("git-scm.com/download/win"));
            }
        }
        println!("[live E2E] windows_git_probe() on this host returned: {:?}", state);
    }

    #[test]
    fn git_hint_nonnative_warns_about_wsl_and_path() {
        let hint = windows_git_install_hint(&WindowsGitState::NonNative).unwrap();
        let lower = hint.to_lowercase();
        // Must call out the WSL/PATH ordering scenario juliandiggins hit so
        // users know exactly what to check.
        assert!(lower.contains("path"), "NonNative hint must mention PATH: {}", hint);
        assert!(
            lower.contains("wsl") || lower.contains("linux"),
            "NonNative hint should mention WSL or Linux: {}",
            hint
        );
        assert!(lower.contains("git-scm.com/download/win"), "got: {}", hint);
    }

    // ── §24.9 — Whisper pip args builder ──────────────────────────────────

    #[test]
    fn whisper_pip_args_install_faster_whisper() {
        let args = build_whisper_pip_args();
        // Drives `python -m pip install … faster-whisper` — the package the
        // STT backend (whisper_server.py) actually imports.
        assert_eq!(&args[..3], &["-m", "pip", "install"]);
        assert!(args.contains(&"faster-whisper"), "must install faster-whisper: {:?}", args);
        // Non-interactive + quiet progress, matching the ComfyUI installer.
        assert!(args.contains(&"--no-input"), "must pass --no-input: {:?}", args);
        let pos = args.iter().position(|a| *a == "--progress-bar");
        assert!(pos.is_some(), "must set --progress-bar: {:?}", args);
        assert_eq!(args[pos.unwrap() + 1], "off");
        // The package name is the LAST arg (after all flags) so pip parses it
        // as the install target, not as a flag value.
        assert_eq!(*args.last().unwrap(), "faster-whisper");
    }
}
