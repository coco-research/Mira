use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Manager, State};
use tracing::{error, info};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::state::AppState;

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Assign a child process to a Windows Job Object with KILL_ON_JOB_CLOSE.
/// When the Tauri parent process dies (even via Task Manager), the OS kernel
/// automatically terminates all processes in the job — no Drop needed.
#[cfg(target_os = "windows")]
fn assign_to_kill_on_close_job(child: &std::process::Child) {
    assign_pid_to_kill_on_close_job(child.id());
}

/// PID-based variant of [`assign_to_kill_on_close_job`]. Usable from spawn paths
/// that don't own a `std::process::Child` — notably `tokio::process::Child`
/// (whose `id()` is `Option<u32>`) in the background-task runner (bg_tasks.rs).
/// Same KILL_ON_JOB_CLOSE semantics; a pid of 0 is ignored.
#[cfg(target_os = "windows")]
pub(crate) fn assign_pid_to_kill_on_close_job(pid: u32) {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::Foundation::*;

    if pid == 0 { return; }
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return; }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );

        let handle = windows_sys::Win32::System::Threading::OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA
            | windows_sys::Win32::System::Threading::PROCESS_TERMINATE,
            0, // FALSE
            pid,
        );
        if !handle.is_null() {
            AssignProcessToJobObject(job, handle);
            CloseHandle(handle);
        }
        // Intentionally leak the job handle — it must stay alive for the duration
        // of the parent process. When the parent dies, the handle is closed by the
        // OS and KILL_ON_JOB_CLOSE triggers.
    }
}

/// Show the main window (called from frontend after React renders)
#[tauri::command]
pub fn show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

/// Bug J: does this system need ComfyUI's --cpu fallback flag?
///
/// ComfyUI 0.21.x's `main.py` calls `get_torch_device()` which calls
/// `torch.cuda.current_device()` unconditionally during import. On systems
/// without an NVIDIA driver, that raises `RuntimeError: Found no NVIDIA
/// driver on your system` and main.py crashes before binding the port.
///
/// We pass `--cpu` to fall back to CPU inference when:
/// - Not on macOS (Mac PyTorch uses MPS, which doesn't touch cuda APIs), AND
/// - `nvidia-smi` is missing or exits non-zero (no NVIDIA card present).
///
/// AMD ROCm + Intel XPU setups CURRENTLY fall into this branch too, which
/// is conservative: they downgrade to CPU instead of crashing. A future
/// enhancement can probe `rocm-smi` / Intel devices and skip `--cpu` for
/// real hardware accel paths. For now the safe default is "no crash."
pub fn needs_cpu_fallback() -> bool {
    if cfg!(target_os = "macos") {
        return false;
    }
    let probe = Command::new("nvidia-smi").output();
    !probe.map(|o| o.status.success()).unwrap_or(false)
}

/// Skip these directories during ComfyUI search
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", "venv", ".venv", "site-packages",
    "Windows", "Program Files", "Program Files (x86)", "$Recycle.Bin", "AppData",
];

fn scan_for_comfyui(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue, // Skip entries with permission errors
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
            continue;
        }
        let full = entry.path();
        // Check if this directory IS ComfyUI
        if name_str.eq_ignore_ascii_case("comfyui") && full.join("main.py").exists() {
            return Some(full);
        }
        // Recurse deeper
        if let Some(found) = scan_for_comfyui(&full, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// Heuristic: does this ComfyUI directory look like a *complete* install,
/// i.e. one that will actually start when we run `python main.py`?
///
/// "Complete" here means: torch is reachable. Two paths qualify:
///
/// 1. Portable variants ship a `python_embeded/` directory with the
///    matching torch wheel pre-baked. We just check that
///    `python_embeded/Lib/site-packages/torch/` exists — fast and avoids
///    spawning a Python process for every dir we scan.
/// 2. From-source installs depend on the system Python having torch.
///    `python_embeded/` won't exist; we sniff the system Python's
///    `Lib/site-packages/torch/` instead. (Best-effort: we only check the
///    canonical "next to python.exe" layout — virtualenvs aren't covered,
///    but those users wouldn't be using LU's auto-install path anyway.)
///
/// Returning `false` for a `main.py`-only carcass is the whole point of
/// P14: a half-cloned ComfyUI dir from a previous abort (Python missing,
/// pip 403, network drop) used to be detected as "installed", which left
/// the user staring at "ComfyUI not responding" forever. Reporting it as
/// incomplete instead lets the install flow retry cleanly.
fn is_comfyui_install_complete(comfy_path: &Path) -> bool {
    if !comfy_path.join("main.py").exists() {
        return false;
    }

    // Path 1: portable layouts (next-to or inside the ComfyUI dir).
    let portable_candidates = [
        comfy_path
            .parent()
            .map(|p| p.join("python_embeded").join("Lib").join("site-packages").join("torch")),
        Some(comfy_path.join("python_embeded").join("Lib").join("site-packages").join("torch")),
    ];
    for c in portable_candidates.into_iter().flatten() {
        if c.exists() {
            return true;
        }
    }

    // Path 2: system Python — derive its prefix from the resolved path
    // and look for torch in the standard sysconfig location. This catches
    // the from-source case where pip dropped torch into the system
    // Python's site-packages.
    let candidate_pythons = collect_candidate_pythons();
    for py in candidate_pythons {
        if let Some(prefix) = Path::new(&py).parent() {
            // Windows layout: <prefix>/Lib/site-packages
            let win_torch = prefix.join("Lib").join("site-packages").join("torch");
            if win_torch.exists() {
                return true;
            }
            // Unix layout: <prefix>/../lib/python3.X/site-packages — be
            // permissive, just look for any torch under <prefix>/../lib.
            if let Some(parent) = prefix.parent() {
                let lib = parent.join("lib");
                if lib.exists() {
                    if let Ok(entries) = std::fs::read_dir(&lib) {
                        for e in entries.flatten() {
                            if e.path().join("site-packages").join("torch").exists() {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }

    false
}

/// Collect the system Python paths we might want to probe. Mirrors the
/// search order in `python::get_python_bin` but returns *all* hits, not
/// just the first — so the carcass check works even when the user has
/// torch installed in a non-default Python.
fn collect_candidate_pythons() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    if !cfg!(target_os = "windows") {
        for bin in &["python3", "python"] {
            out.push(bin.to_string());
        }
        return out;
    }

    // `where python` candidates (excluding WindowsApps stub).
    let mut where_cmd = Command::new("where");
    where_cmd.arg("python");
    #[cfg(target_os = "windows")]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let path = line.trim();
                if !path.is_empty() && !path.contains("WindowsApps") {
                    out.push(path.to_string());
                }
            }
        }
    }

    for p in [
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
    ] {
        if Path::new(p).exists() {
            out.push(p.to_string());
        }
    }

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let programs = Path::new(&localappdata).join("Programs").join("Python");
        if let Ok(entries) = std::fs::read_dir(&programs) {
            for e in entries.flatten() {
                let py = e.path().join("python.exe");
                if py.exists() {
                    out.push(py.to_string_lossy().to_string());
                }
            }
        }
    }

    out
}

/// Probe order for the ComfyUI Desktop App's Working Directory when the
/// user-supplied path is the binary install dir (contains `ComfyUI.exe` but
/// no `main.py`). Comfy-Org/desktop lets the user pick this dir at install
/// time and defaults to `~\Documents\ComfyUI`. We additionally try the
/// `%APPDATA%\ComfyUI\config.json` `basePath` hint which the desktop app
/// writes after the picker, and the legacy `electron-userdata` location.
fn desktop_app_working_dir_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home = dirs::home_dir().unwrap_or_default();
    out.push(home.join("Documents").join("ComfyUI"));
    out.push(home.join("Documents").join("ComfyUI").join("ComfyUI"));
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            // 1. config.json basePath hint, if present
            let cfg = PathBuf::from(&appdata).join("ComfyUI").join("config.json");
            if let Ok(raw) = std::fs::read_to_string(&cfg) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(p) = v.get("basePath").and_then(|x| x.as_str()) {
                        out.push(PathBuf::from(p));
                    }
                }
            }
            // 2. %APPDATA%\ComfyUI itself (some installer variants)
            out.push(PathBuf::from(&appdata).join("ComfyUI"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            out.push(PathBuf::from(&localappdata).join("ComfyUI"));
            // The desktop installer also bundles a ComfyUI tree under the
            // app's resources for first-launch seeding.
            out.push(PathBuf::from(&localappdata).join("Programs").join("ComfyUI").join("resources").join("ComfyUI"));
        }
    }
    out
}

/// Best-effort: turn whatever the user/auto-detector handed us into a
/// directory that contains `main.py`. Accepts either:
///   - A directory with `main.py` (classic / portable / from-source install)
///   - A directory with `ComfyUI.exe` (Comfy-Org desktop app binary dir) —
///     we then look up the Working Directory via the probe order above.
fn resolve_comfyui_path(input: &str) -> Option<String> {
    let p = Path::new(input);
    if p.join("main.py").exists() {
        return Some(input.to_string());
    }
    if p.join("ComfyUI.exe").exists() {
        for candidate in desktop_app_working_dir_candidates() {
            if candidate.join("main.py").exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

pub fn find_comfyui_path() -> Option<String> {
    // 1. Check environment variable
    if let Ok(env_path) = std::env::var("COMFYUI_PATH") {
        if let Some(p) = resolve_comfyui_path(&env_path) {
            return Some(p);
        }
    }

    // 2. Read from app config
    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if config_file.exists() {
            if let Ok(content) = fs::read_to_string(&config_file) {
                if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(path) = config.get("comfyui_path").and_then(|v| v.as_str()) {
                        if let Some(resolved) = resolve_comfyui_path(path) {
                            return Some(resolved);
                        }
                    }
                }
            }
        }
    }

    // 2b. Deep scan user home directory (finds ComfyUI in non-standard paths like Desktop/bs/IMage Gen/ComfyUI)
    let home2 = dirs::home_dir().unwrap_or_default();
    if let Some(found) = scan_for_comfyui(&home2, 7) {
        println!("[ComfyUI] Found via deep home scan: {}", found.display());
        return Some(found.to_string_lossy().to_string());
    }

    let home = dirs::home_dir().unwrap_or_default();

    // 3. Check common fixed locations (including Stability Matrix, portable installs)
    let mut fixed: Vec<PathBuf> = vec![
        home.join("ComfyUI"),
        home.join("Desktop").join("ComfyUI"),
        home.join("Documents").join("ComfyUI"),
        PathBuf::from("C:\\ComfyUI"),
        PathBuf::from("D:\\ComfyUI"),
    ];

    if cfg!(target_os = "windows") {
        // Stability Matrix stores ComfyUI in AppData
        if let Ok(appdata) = std::env::var("APPDATA") {
            fixed.push(PathBuf::from(&appdata).join("StabilityMatrix").join("Packages").join("ComfyUI"));
            // Comfy-Org/desktop app working dir (GH #47, levoy1 2026-05-24)
            fixed.push(PathBuf::from(&appdata).join("ComfyUI"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            fixed.push(PathBuf::from(&localappdata).join("StabilityMatrix").join("Packages").join("ComfyUI"));
            fixed.push(PathBuf::from(&localappdata).join("ComfyUI"));
        }
        // Common Program Files locations
        fixed.push(PathBuf::from("C:\\Program Files\\ComfyUI"));
        fixed.push(PathBuf::from("C:\\AI\\ComfyUI"));
        fixed.push(PathBuf::from("D:\\AI\\ComfyUI"));
    }

    for p in &fixed {
        if p.join("main.py").exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }

    // 4. Recursive scan of Desktop, Documents, Downloads, and drive roots
    let mut scan_roots: Vec<PathBuf> = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
    ];
    if cfg!(target_os = "windows") {
        scan_roots.push(PathBuf::from("C:\\"));
        scan_roots.push(PathBuf::from("D:\\"));
        scan_roots.push(PathBuf::from("E:\\"));
    } else {
        scan_roots.push(PathBuf::from("/opt"));
        scan_roots.push(PathBuf::from("/usr/local"));
    }

    for root in &scan_roots {
        if root.exists() {
            if let Some(found) = scan_for_comfyui(root, 5) {
                return Some(found.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Information about a discovered ComfyUI install — surfaced to the
/// frontend so the user picks the right one when multiple coexist.
///
/// Background (Bug #3 — ninjastic2008 v2.4.3): a user with both a manual
/// `C:\Users\admin\ComfyUI` install (complete, with its own python_embeded)
/// AND an empty `C:\ComfyUI-ai` directory hit `find_comfyui_path()` which
/// returned only the first hit (their manual install). LU then tried to
/// drive that install using the system Python — incompatible with the
/// dir's bundled python_embeded — and ComfyUI loaded indefinitely. The
/// "complete + has_embedded_python" fields let the onboarding UI explain
/// which path to pick and why.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ComfyUIInstall {
    pub path: String,
    /// True when this directory looks ready to start without any further
    /// pip steps (main.py + torch reachable). Same heuristic as
    /// `is_comfyui_install_complete`.
    pub complete: bool,
    /// True when the directory ships its own `python_embeded\python.exe`.
    /// Portable ComfyUI builds (and Stability Matrix packages) ship one;
    /// from-source clones don't. We start ComfyUI with this Python when
    /// present — using the system Python on a portable install was the
    /// exact failure mode ninjastic2008 hit.
    pub has_embedded_python: bool,
    /// Where we found this install. Helps the user disambiguate.
    pub source: String,
}

fn classify_comfy_install(path: &Path, source: &str) -> ComfyUIInstall {
    let has_embed = path.join("python_embeded").join("python.exe").exists()
        || path
            .parent()
            .map(|p| p.join("python_embeded").join("python.exe").exists())
            .unwrap_or(false);
    ComfyUIInstall {
        path: path.to_string_lossy().to_string(),
        complete: is_comfyui_install_complete(path),
        has_embedded_python: has_embed,
        source: source.to_string(),
    }
}

/// Enumerate every plausible ComfyUI install on the box. Used by the
/// onboarding UI to decide between auto-pick (one hit) and an explicit
/// picker (multiple hits).
///
/// Performance contract: this MUST finish in under ~3 s even on machines
/// with deep file trees. The implementation is `async` so it runs on
/// tokio's blocking-thread pool instead of the IPC main thread — without
/// that the Tauri WebView lock-up on a 200k-file home dir made the whole
/// app report "Not responding" during the ComfyUI step. (Bug #3 sweep,
/// found during E2E 2026-05-11.)
///
/// Scan tiers, in order:
///   1. Explicit pointers — env var, config.json
///   2. Well-known fixed locations (home/Desktop/Documents/StabilityMatrix/…)
///   3. Bounded deep scan of the user's data dirs (depth 4, skip noise)
///   We DO NOT walk C:\, D:\, E:\ from their roots anymore — that path was
///   the locker. find_comfyui_path keeps its drive-root fallback for the
///   single-hit auto-pick case which can afford a slow first-match exit.
#[tauri::command]
pub async fn detect_all_comfyui_installs() -> Vec<ComfyUIInstall> {
    tokio::task::spawn_blocking(detect_all_comfyui_installs_sync)
        .await
        .unwrap_or_default()
}

const MAX_MULTI_DETECT_HITS: usize = 16;
const MULTI_DETECT_DEPTH: i32 = 4;

fn detect_all_comfyui_installs_sync() -> Vec<ComfyUIInstall> {
    let mut out: Vec<ComfyUIInstall> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push_if_new = |path: PathBuf, source: &str, out: &mut Vec<ComfyUIInstall>, seen: &mut std::collections::HashSet<String>| -> bool {
        if !path.join("main.py").exists() {
            return false;
        }
        // Canonicalise to dedupe symlinks / case-different paths on Windows
        let key = std::fs::canonicalize(&path)
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string())
            .to_lowercase();
        if seen.insert(key) {
            out.push(classify_comfy_install(&path, source));
            return true;
        }
        false
    };

    // 1. COMFYUI_PATH env var
    if let Ok(env_path) = std::env::var("COMFYUI_PATH") {
        push_if_new(PathBuf::from(&env_path), "COMFYUI_PATH env var", &mut out, &mut seen);
    }

    // 2. app config.json
    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if let Ok(content) = fs::read_to_string(&config_file) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(path) = config.get("comfyui_path").and_then(|v| v.as_str()) {
                    push_if_new(PathBuf::from(path), "config.json", &mut out, &mut seen);
                }
            }
        }
    }

    let home = dirs::home_dir().unwrap_or_default();

    // 3. Well-known fixed locations
    let mut fixed: Vec<(PathBuf, &str)> = vec![
        (home.join("ComfyUI"), "home"),
        (home.join("Desktop").join("ComfyUI"), "Desktop"),
        (home.join("Documents").join("ComfyUI"), "Documents"),
        (PathBuf::from("C:\\ComfyUI"), "C:\\"),
        (PathBuf::from("D:\\ComfyUI"), "D:\\"),
    ];
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            fixed.push((PathBuf::from(&appdata).join("StabilityMatrix").join("Packages").join("ComfyUI"), "StabilityMatrix"));
            // Comfy-Org/desktop default Working Directory hint (GH #47).
            fixed.push((PathBuf::from(&appdata).join("ComfyUI"), "Desktop App data"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            fixed.push((PathBuf::from(&localappdata).join("StabilityMatrix").join("Packages").join("ComfyUI"), "StabilityMatrix"));
            fixed.push((PathBuf::from(&localappdata).join("ComfyUI"), "Desktop App data"));
        }
        fixed.push((PathBuf::from("C:\\Program Files\\ComfyUI"), "Program Files"));
        fixed.push((PathBuf::from("C:\\AI\\ComfyUI"), "C:\\AI"));
        fixed.push((PathBuf::from("D:\\AI\\ComfyUI"), "D:\\AI"));
        // ComfyUI Desktop App often pairs its `%LOCALAPPDATA%\Programs\ComfyUI`
        // binary with a `%APPDATA%\ComfyUI\config.json` whose `basePath` field
        // points at the Working Directory. Honour the hint so users with a
        // non-default Working Dir (e.g. on D:\ for space) are still found.
        if let Ok(appdata) = std::env::var("APPDATA") {
            let cfg = PathBuf::from(&appdata).join("ComfyUI").join("config.json");
            if let Ok(raw) = std::fs::read_to_string(&cfg) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(base) = v.get("basePath").and_then(|x| x.as_str()) {
                        fixed.push((PathBuf::from(base), "Desktop App basePath"));
                    }
                }
            }
        }
    }
    for (p, source) in fixed {
        push_if_new(p, source, &mut out, &mut seen);
    }

    // 4. Bounded deep scan — user data dirs only. Drive roots (C:\, D:\, E:\)
    //    are intentionally NOT walked here: the deep walk through hundreds of
    //    thousands of system files made `detect_all_comfyui_installs` lock
    //    Tauri for 30+ s on real Windows boxes. Power users with ComfyUI in
    //    `D:\AI\projects\custom\dir\` still get auto-picked by find_comfyui_path
    //    (single-hit, slow first-match-exit) — they just don't surface in the
    //    Multi-ComfyUI picker, which is acceptable: that picker exists for
    //    accidental multi-install collisions, not exhaustive enumeration.
    let scan_roots: Vec<(PathBuf, &str)> = vec![
        (home.clone(), "home (deep scan)"),
        (home.join("Desktop"), "Desktop"),
        (home.join("Documents"), "Documents"),
        (home.join("Downloads"), "Downloads"),
    ];
    for (root, source) in &scan_roots {
        if out.len() >= MAX_MULTI_DETECT_HITS {
            break;
        }
        if root.exists() {
            walk_for_comfyui(root, MULTI_DETECT_DEPTH, &mut |p| {
                if out.len() >= MAX_MULTI_DETECT_HITS {
                    return;
                }
                push_if_new(p, source, &mut out, &mut seen);
            });
        }
    }

    out
}

fn walk_for_comfyui<F: FnMut(PathBuf)>(dir: &Path, depth: i32, cb: &mut F) {
    if depth < 0 {
        return;
    }
    if dir.join("main.py").exists() && dir.join("comfy").exists() {
        cb(dir.to_path_buf());
        // Don't recurse into a confirmed install — its subdirs aren't
        // independent installs.
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        // Skip the obvious noise dirs that blow up walk time. node_modules
        // and .git are common in dev projects; the rest are system locations
        // that should never own a ComfyUI install anyway.
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            if matches!(name,
                "node_modules" | ".git" | "AppData" | "$Recycle.Bin"
                | "Windows" | "System32" | "ProgramData" | ".cache"
                | "target" | ".cargo" | ".rustup" | ".npm" | ".pnpm"
                | "Library"     // macOS, harmless on Windows
                | "OneDrive"    // huge synced trees; ComfyUI shouldn't live there
            ) {
                continue;
            }
            // Hidden dirs (Linux/macOS dotfiles) are almost never ComfyUI roots.
            if name.starts_with('.') && name.len() > 1 {
                continue;
            }
        }
        walk_for_comfyui(&p, depth - 1, cb);
    }
}

fn is_comfyui_running_on_port(port: u16) -> bool {
    reqwest::blocking::get(format!("http://localhost:{}/system_stats", port))
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn start_ollama(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Check if already running
    {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", "IMAGENAME eq ollama.exe"]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("ollama.exe") {
                println!("[Ollama] Already running");
                return Ok(serde_json::json!({"status": "already_running"}));
            }
        }
    }

    println!("[Ollama] Starting...");
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Bug BB v2.5.0 — BobbyT. Forward the user's GPU pick as
    // CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR
    // so Ollama uses the pinned card on multi-vendor / multi-GPU machines.
    // No-op when the pick is "auto" (default).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let result = cmd.spawn();

    match result {
        Ok(child) => {
            // Store the Child so AppState::Drop kills our spawned ollama on
            // shutdown (kj103x — Discord 2026-05-23 #help-chat 1507756765612216411).
            // Note: tasklist check above means we only get here if WE start it,
            // so we never kill a user-managed ollama serve.
            *state.ollama_process.lock().unwrap() = Some(child);
            println!("[Ollama] Started");
            info!("ollama spawned");
            Ok(serde_json::json!({"status": "started"}))
        }
        Err(e) => {
            println!("[Ollama] Failed to start: {}", e);
            error!(error = %e, "ollama spawn failed");
            Ok(serde_json::json!({"status": "error", "error": e.to_string()}))
        }
    }
}

/// Does `python` have a working flash-attn? Real import test (not pip-list):
/// a half-installed or ABI-mismatched wheel fails the import, and we must
/// never pass `--use-flash-attention` then — ComfyUI would error at startup.
///
/// Three-state result: Some(true) = import OK, Some(false) = the process
/// DEFINITIVELY failed (ImportError etc.), None = timeout / couldn't spawn.
/// The distinction matters for caching: importing flash_attn loads torch,
/// which is ~4 s warm but can blow well past 25 s during an app-boot disk
/// storm (live miss 2026-06-11: flag silently absent for the whole session
/// because a cold-start timeout was cached as "not installed").
pub(crate) fn probe_flash_attention(python: &str) -> Option<bool> {
    if python.is_empty() {
        return Some(false);
    }
    let mut cmd = Command::new(python);
    cmd.args(["-c", "from flash_attn import flash_attn_func"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return None,
    };
    // 90 s ceiling: an ABSENT package fails fast (ModuleNotFoundError in
    // seconds), so the long window only ever delays a start where flash-attn
    // exists but the disk is busy — exactly the case worth waiting for.
    for _ in 0..450 {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(_) => return None,
        }
    }
    let _ = child.kill();
    None
}

/// Probe with per-python cache. Only DEFINITIVE results are cached — a
/// timeout returns false for this call but is retried on the next start,
/// so one slow boot can't disable Flash Attention for the whole session.
fn flash_attention_cached(state: &AppState, python: &str) -> bool {
    if let Some(v) = state.flash_attn_cache.lock().unwrap().get(python).copied() {
        return v;
    }
    match probe_flash_attention(python) {
        Some(v) => {
            state
                .flash_attn_cache
                .lock()
                .unwrap()
                .insert(python.to_string(), v);
            v
        }
        None => {
            println!("[ComfyUI] flash-attn probe timed out — starting without the flag (will retry next start)");
            false
        }
    }
}

/// Same bundled-portable → venv → system resolution order as start_comfyui,
/// without the logging — used by check_flash_attention so the Create tab
/// probes the EXACT interpreter that will run ComfyUI.
fn resolve_comfyui_python(comfy_path: &str, system_python: String) -> String {
    let portable_python = std::path::Path::new(comfy_path).parent().and_then(|p| {
        let candidate = p.join("python_embeded").join("python.exe");
        if candidate.exists() {
            Some(candidate.to_string_lossy().to_string())
        } else {
            None
        }
    });
    let bundled_python = portable_python.or_else(|| {
        let candidate = std::path::Path::new(comfy_path)
            .join("python_embeded")
            .join("python.exe");
        if candidate.exists() {
            Some(candidate.to_string_lossy().to_string())
        } else {
            None
        }
    });
    let venv_python =
        crate::python::resolve_comfyui_venv_python(std::path::Path::new(comfy_path));
    bundled_python.or(venv_python).unwrap_or(system_python)
}

/// Create-tab check (David 2026-06-11): flash-attn makes WAN-class video
/// sampling 4-5x faster (measured 27 s/it vs 108-160 s/it on his RTX 3060,
/// identical workload). The tab shows a minimal hint when it's missing.
#[tauri::command]
pub fn check_flash_attention(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            return Ok(serde_json::json!({"available": false, "reason": "remote"}));
        }
    }
    let comfy_path = state
        .comfy_path
        .lock()
        .unwrap()
        .clone()
        .or_else(find_comfyui_path);
    let Some(comfy_path) = comfy_path else {
        return Ok(serde_json::json!({"available": false, "reason": "no_comfyui"}));
    };
    let system_python = state.python_bin.lock().unwrap().clone();
    let python = resolve_comfyui_python(&comfy_path, system_python);
    if python.is_empty() {
        return Ok(serde_json::json!({"available": false, "reason": "no_python"}));
    }
    let available = flash_attention_cached(&state, &python);
    Ok(serde_json::json!({"available": available, "python": python}))
}

#[tauri::command]
pub fn start_comfyui(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // If user pointed LU at a remote ComfyUI, we have no local process to spawn.
    // Just report status — the remote side is responsible for running ComfyUI.
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            return Ok(serde_json::json!({
                "status": "remote",
                "host": host,
                "message": "Remote ComfyUI — manage the Python process on the server itself"
            }));
        }
    }

    let port = *state.comfy_port.lock().unwrap();

    if is_comfyui_running_on_port(port) {
        return Ok(serde_json::json!({"status": "already_running"}));
    }

    let comfy_path = {
        let path = state.comfy_path.lock().unwrap();
        path.clone()
    };

    let comfy_path = comfy_path
        .or_else(|| find_comfyui_path())
        .ok_or_else(|| "ComfyUI not found".to_string())?;

    // Store the path for future use
    {
        let mut path = state.comfy_path.lock().unwrap();
        *path = Some(comfy_path.clone());
    }

    // Prefer the portable's bundled Python over the system one. ComfyUI
    // Portable (NVIDIA, AMD, CPU variants) ships its own Python with the
    // matching torch wheel pre-installed — using the system Python instead
    // wastes that and on AMD it actively fails because system Python lacks
    // the DirectML / ROCm bindings the portable installer prepared. Layout:
    //   <ComfyUI>/python_embeded/python.exe   ← what we want
    //   <ComfyUI>/main.py
    // Fixed Discord report from reload__: AMD Portable launchte nicht.
    let portable_python = std::path::Path::new(&comfy_path)
        .parent()
        .and_then(|p| {
            let candidate = p.join("python_embeded").join("python.exe");
            if candidate.exists() { Some(candidate.to_string_lossy().to_string()) } else { None }
        });
    let bundled_python = portable_python.or_else(|| {
        // Some portable variants nest python_embeded inside the ComfyUI dir
        // itself rather than alongside it.
        let candidate = std::path::Path::new(&comfy_path).join("python_embeded").join("python.exe");
        if candidate.exists() { Some(candidate.to_string_lossy().to_string()) } else { None }
    });
    // Bug E (rzgrozt — Arch PEP 668): when the installer detected an
    // externally-managed Python it created a venv at <ComfyUI>/venv and
    // installed PyTorch + deps into it. Launch from the venv so we don't
    // crash with `ModuleNotFoundError: torch` because the system Python
    // (which is what `state.python_bin` resolves to) never received those
    // packages. Falls back to bundled portable (Windows) or system (Mac /
    // older Linux without PEP 668) when no venv exists.
    let venv_python = crate::python::resolve_comfyui_venv_python(std::path::Path::new(&comfy_path));
    let system_python = state.python_bin.lock().unwrap().clone();
    let python = bundled_python
        .clone()
        .or_else(|| venv_python.clone())
        .unwrap_or(system_python.clone());
    let port_str = port.to_string();
    if python.is_empty() {
        return Err(
            "No Python available — install Python first (Settings → ComfyUI → Install Python). \
             ComfyUI from-source needs a system Python; install one and retry."
                .to_string(),
        );
    }
    if bundled_python.is_some() {
        println!("[ComfyUI] Using bundled portable Python: {}", python);
    } else if venv_python.is_some() {
        println!("[ComfyUI] Using ComfyUI venv Python (PEP 668 install): {}", python);
    } else {
        println!("[ComfyUI] Using system Python: {}", python);
    }
    println!("[ComfyUI] Starting from: {} on port {}", comfy_path, port);
    info!(port = port, "comfyui start");

    // Bug J (discovered during 2026-05-17 Arch live test): on systems without
    // an NVIDIA driver (most Linux non-NVIDIA setups: AMD, Intel, CPU-only;
    // also Windows boxes without an NVIDIA card), ComfyUI's main.py calls
    // get_torch_device() → torch.cuda.current_device() → which raises
    // `RuntimeError: Found no NVIDIA driver on your system` before
    // main.py ever binds the port. The user sees LU stuck on "ComfyUI
    // loading..." (which Bug B's 60-s panel now correctly surfaces, but
    // the underlying spawn-then-crash loop wastes the user's time on every
    // start). Detect NVIDIA via `nvidia-smi` and pass --cpu when absent,
    // except on macOS where PyTorch uses MPS and never calls cuda APIs.
    let needs_cpu_fallback = needs_cpu_fallback();
    let mut comfy_args: Vec<&str> = vec![
        "main.py",
        "--listen", "127.0.0.1",
        "--port", &port_str,
        "--enable-cors-header", "*",
    ];
    if needs_cpu_fallback {
        comfy_args.push("--cpu");
        println!("[ComfyUI] No NVIDIA driver detected — passing --cpu to ComfyUI (CPU inference fallback)");
    }
    // Auto-enable Flash Attention when the package actually imports in THIS
    // python (David 2026-06-11: measured 4-5x faster WAN video sampling vs
    // pytorch SDPA on a 12 GB 3060). ComfyUI only uses FA2 with the flag, so
    // an installed wheel does nothing without this. The real-import probe
    // guarantees we never pass the flag on a broken install (ComfyUI would
    // error at startup); probe result is cached per python path. CPU mode
    // skips it — flash-attn is CUDA-only.
    if !needs_cpu_fallback && flash_attention_cached(&state, &python) {
        comfy_args.push("--use-flash-attention");
        println!("[ComfyUI] flash-attn detected in {} — enabling Flash Attention", python);
    }
    let mut cmd = Command::new(&python);
    cmd.args(&comfy_args)
        .current_dir(&comfy_path)
        .env("TQDM_DISABLE", "1")
        .env("PYTHONUNBUFFERED", "1")
        // Windows fix (plum133, Discord 2026-06-07): ComfyUI / its nodes print
        // Unicode progress glyphs (e.g. '▍' U+258D) to stdout. On a non-UTF-8
        // Windows console codepage (cp1252) Python's *piped* stdout defaults to
        // the locale codec and raises UnicodeEncodeError ("'charmap' codec
        // can't encode character '▍' …"), which propagates out of the
        // KSampler progress callback and aborts generation ("Generation
        // failed: … (KSampler)"). Force UTF-8 I/O so any Unicode output is
        // encodable on every locale — also keeps the Rust-side line reader's
        // UTF-8 assumption valid.
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Bug BB v2.5.0 — same GPU env forwarding as start_ollama. ComfyUI's
    // backend (torch / DirectML / IPEX) reads these on import, so the pick
    // takes effect on next spawn (current process must be restarted for a
    // change to apply — surfaced as a hint in the Settings UI).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()
        .map_err(|e| {
            error!(error = %e, python = %python, "comfyui start failed");
            format!("Failed to start ComfyUI (python={}): {}", python, e)
        })?;

    // Assign to Job Object so child dies when parent dies (even via Task Manager)
    #[cfg(target_os = "windows")]
    assign_to_kill_on_close_job(&child);

    // Drain stdout/stderr in background threads to prevent buffer deadlock
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("[ComfyUI] {}", line);
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("[ComfyUI] {}", line);
                }
            }
        });
    }

    // Store process
    {
        let mut proc = state.comfy_process.lock().unwrap();
        *proc = Some(child);
    }

    println!("[ComfyUI] Started");
    info!("comfyui started");
    Ok(serde_json::json!({"status": "started", "path": comfy_path}))
}

#[tauri::command]
pub fn stop_comfyui(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut proc = state.comfy_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let pid = child.id();
        if cfg!(target_os = "windows") {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
        } else {
            let _ = child.kill();
        }
        *proc = None;
        println!("[ComfyUI] Stopped");
        info!(pid = pid, "comfyui stopped");
        Ok(serde_json::json!({"status": "stopped"}))
    } else {
        Ok(serde_json::json!({"status": "not_running"}))
    }
}

#[tauri::command]
pub async fn comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let port = *state.comfy_port.lock().unwrap();
    let host = state.comfy_host.lock().unwrap().clone();
    let is_local = is_local_host(&host);

    // Probe the configured host (not just localhost). Remote ComfyUI
    // still reports running: true if the /system_stats endpoint responds.
    let running = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| Some(c.get(format!("http://{}:{}/system_stats", host, port))))
        .map(|req| async move { req.send().await.map(|r| r.status().is_success()).unwrap_or(false) })
    ;
    let running = match running {
        Some(fut) => fut.await,
        None => false,
    };

    // Reap the spawned child so a crash-on-startup doesn't read as "alive".
    // We store the Child from start_comfyui in state.comfy_process. If that
    // process exits early (the classic case: ComfyUI's main.py aborts on a bad
    // dependency / missing torch / SQLAlchemy<2.0 / "no NVIDIA driver" before it
    // binds the port), the handle would otherwise linger as Some(_) forever —
    // making process_alive=true and therefore `starting` (process_alive &&
    // !running) STICK TRUE INDEFINITELY. The user then stares at an endless
    // "ComfyUI starting…" with no error. try_wait() detects the early exit so we
    // clear the handle and report "stopped", letting the UI re-offer "click to
    // start" + the troubleshoot panel instead of a phantom loading state.
    let process_alive = {
        let mut proc = state.comfy_process.lock().unwrap();
        match proc.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    error!(exit = ?status, "comfyui process exited early (crash on startup?) — clearing handle");
                    *proc = None;
                    false
                }
                Ok(None) => true,  // still running; just hasn't bound the port yet
                Err(_) => true,    // can't determine — assume alive, don't thrash
            },
            None => false,
        }
    };

    let path = {
        let p = state.comfy_path.lock().unwrap();
        p.clone()
    };

    // For remote hosts we don't care whether a local install path exists.
    let resolved_path: Option<String> = if is_local {
        path.clone().or_else(find_comfyui_path)
    } else {
        None
    };

    let found = if is_local {
        resolved_path.is_some()
    } else {
        true  // the remote side handles its own install
    };

    // Carcass detection: a local install is only "complete" if torch is
    // actually reachable. Remote hosts are reported complete by definition
    // — the remote side owns its own install state.
    let complete = if is_local {
        match &resolved_path {
            Some(p) => is_comfyui_install_complete(Path::new(p)),
            None => false,
        }
    } else {
        true
    };

    Ok(serde_json::json!({
        "running": running,
        "starting": process_alive && !running,
        "found": found,
        "complete": complete,
        "path": path,
        "port": port,
        "host": host,
        "isLocal": is_local,
        "processAlive": process_alive,
    }))
}

/// Returns true when `host` refers to the local machine.
/// Anything else = remote and LU won't try to manage the process.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0" | "")
}

#[tauri::command]
pub fn find_comfyui() -> Result<serde_json::Value, String> {
    match find_comfyui_path() {
        Some(path) => {
            // Surface install completeness so the UI can distinguish a
            // working ComfyUI from a half-cloned carcass and offer the
            // right action (Continue vs. Re-install). See
            // is_comfyui_install_complete for the definition of "complete".
            let complete = is_comfyui_install_complete(Path::new(&path));
            Ok(serde_json::json!({
                "found": true,
                "path": path,
                "complete": complete,
            }))
        }
        None => Ok(serde_json::json!({
            "found": false,
            "path": null,
            "complete": false,
        })),
    }
}

#[tauri::command]
pub fn set_comfyui_path(path: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Resolve the path the user gave us to a directory that actually contains
    // `main.py`. Direct hit short-circuits; otherwise we look at the ComfyUI
    // Desktop App layout (Comfy-Org/desktop, GH #47, levoy1 2026-05-24): the
    // user typically points at `%LOCALAPPDATA%\Programs\ComfyUI` (the binary
    // dir with `ComfyUI.exe` next to no `main.py`) because that's what their
    // shortcut targets, but the actual Working Directory with `main.py` +
    // `models/` + `custom_nodes/` lives under `~\Documents\ComfyUI` or
    // `%APPDATA%\ComfyUI` depending on the install picker. We transparently
    // re-route in that case so the error doesn't look unfixable.
    let resolved = resolve_comfyui_path(&path)
        .ok_or_else(|| {
            if Path::new(&path).join("ComfyUI.exe").exists() {
                format!(
                    "Looks like the ComfyUI Desktop App binary folder ({}). LU needs the ComfyUI Working Directory (with main.py, models/, custom_nodes/) — by default `~\\Documents\\ComfyUI` or wherever you picked during install. Open the Desktop App once, check Settings → ComfyUI Working Directory, and paste that path here.",
                    path
                )
            } else {
                format!("main.py not found in {}", path)
            }
        })?;

    let path = resolved;

    // Store in memory
    {
        let mut p = state.comfy_path.lock().unwrap();
        *p = Some(path.clone());
    }

    // Persist to config file
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_path"] = serde_json::json!(path);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    Ok(serde_json::json!({"status": "saved", "path": path}))
}

#[tauri::command]
pub fn set_comfyui_host(host: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Host must not be empty".to_string());
    }
    // Reject obviously invalid chars — helps avoid URL-injection style typos.
    if trimmed.contains('/') || trimmed.contains(' ') || trimmed.contains('?') {
        return Err("Host must be a plain hostname or IP, no slashes/spaces".to_string());
    }
    let final_host = trimmed.to_string();

    {
        let mut h = state.comfy_host.lock().unwrap();
        *h = final_host.clone();
    }

    // Persist to config file
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_host"] = serde_json::json!(final_host);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    let is_local = is_local_host(&final_host);
    println!("[ComfyUI] Host set to {} (local={})", final_host, is_local);
    Ok(serde_json::json!({"status": "saved", "host": final_host, "isLocal": is_local}))
}

#[tauri::command]
pub fn set_comfyui_port(port: u16, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if port == 0 {
        return Err("Port must be greater than 0".to_string());
    }

    {
        let mut p = state.comfy_port.lock().unwrap();
        *p = port;
    }

    // Persist to config file
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_port"] = serde_json::json!(port);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    println!("[ComfyUI] Port set to {}", port);
    Ok(serde_json::json!({"status": "saved", "port": port}))
}

/// Normalize user input into a full Ollama base URL.
/// Accepts bare `host:port`, scheme-less host, or full URL.
/// Returns full URL without trailing slash, or Err for obviously bad input.
fn normalize_ollama_base(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Endpoint must not be empty".into());
    }
    // Reject whitespace / newlines inside the URL.
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("Endpoint must not contain whitespace".into());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    // Sanity-check with a URL parse so "http://" alone or "http://:1234" can't pass.
    match url::Url::parse(&with_scheme) {
        Ok(u) if u.host_str().map_or(false, |h| !h.is_empty()) => Ok(with_scheme),
        _ => Err(format!("Not a valid URL: {}", input)),
    }
}

#[tauri::command]
pub fn set_ollama_host(host: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let final_base = normalize_ollama_base(&host)?;

    {
        let mut b = state.ollama_base.lock().unwrap();
        *b = final_base.clone();
    }

    // Persist to config file under ollama_base — next startup will pick it
    // up via load_ollama_base() before any request fires.
    if let Some(config_dir) = dirs::config_dir() {
        let app_config = config_dir.join("locally-uncensored");
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["ollama_base"] = serde_json::json!(final_base);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    let is_local = url::Url::parse(&final_base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"))
        .unwrap_or(false);

    println!("[Ollama] Base URL set to {} (local={})", final_base, is_local);
    Ok(serde_json::json!({"status": "saved", "base": final_base, "isLocal": is_local}))
}

#[tauri::command]
pub fn get_ollama_host(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let base = state.ollama_base.lock().unwrap().clone();
    let is_local = url::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"))
        .unwrap_or(false);
    Ok(serde_json::json!({"base": base, "isLocal": is_local}))
}

/// Auto-start Ollama on app launch (called from setup)
pub fn auto_start_ollama(state: &AppState) {
    // Check if already running
    {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", "IMAGENAME eq ollama.exe"]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("ollama.exe") {
                println!("[Ollama] Already running");
                return;
            }
        }
    }

    println!("[Ollama] Starting...");
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(child) => {
            // Same orphan-prevention rationale as `start_ollama` above.
            *state.ollama_process.lock().unwrap() = Some(child);
            println!("[Ollama] Started");
        }
        Err(e) => println!("[Ollama] Failed to start: {}", e),
    }
}

/// Auto-start ComfyUI on app launch (called from setup)
pub fn auto_start_comfyui(state: &AppState) {
    // If user configured a remote host, don't try to auto-start anything locally.
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            println!("[ComfyUI] Remote host configured ({}), skipping local auto-start", host);
            return;
        }
    }

    // Always try to find and store the ComfyUI path (needed for downloads)
    if state.comfy_path.lock().unwrap().is_none() {
        if let Some(path) = find_comfyui_path() {
            println!("[ComfyUI] Found at: {}", path);
            *state.comfy_path.lock().unwrap() = Some(path);
        }
    }

    let port = *state.comfy_port.lock().unwrap();

    if is_comfyui_running_on_port(port) {
        println!("[ComfyUI] Already running on port {}", port);
        return;
    }

    match find_comfyui_path() {
        Some(path) => {
            let port_str = port.to_string();
            println!("[ComfyUI] Auto-starting from: {} on port {}", path, port);
            *state.comfy_path.lock().unwrap() = Some(path.clone());

            // Mirror the start_comfyui Python preference: use the portable's
            // bundled Python when present so AMD / cu126 / CPU portables boot
            // with the right torch wheel. See start_comfyui for full context.
            let portable_python = std::path::Path::new(&path)
                .parent()
                .and_then(|p| {
                    let c = p.join("python_embeded").join("python.exe");
                    if c.exists() { Some(c.to_string_lossy().to_string()) } else { None }
                })
                .or_else(|| {
                    let c = std::path::Path::new(&path).join("python_embeded").join("python.exe");
                    if c.exists() { Some(c.to_string_lossy().to_string()) } else { None }
                });
            // Bug E: prefer the per-install venv that the PEP 668 path
            // creates (Arch / Debian 12+ / Fedora 38+ / Ubuntu 23.04+).
            // Without this auto-start would launch with the system Python
            // that doesn't have torch and crash on first import.
            let venv_python = crate::python::resolve_comfyui_venv_python(std::path::Path::new(&path));
            let system_python = state.python_bin.lock().unwrap().clone();
            let python = portable_python
                .clone()
                .or_else(|| venv_python.clone())
                .unwrap_or_else(|| system_python.clone());
            if python.is_empty() {
                println!("[ComfyUI] Auto-start skipped: no Python available (install via P14 flow)");
                return;
            }
            if portable_python.is_some() {
                println!("[ComfyUI] Auto-start using bundled portable Python: {}", python);
            } else if venv_python.is_some() {
                println!("[ComfyUI] Auto-start using ComfyUI venv Python (PEP 668 install): {}", python);
            }

            // Bug J: same --cpu fallback as start_comfyui to avoid the
            // "Found no NVIDIA driver" crash loop on non-NVIDIA systems.
            let auto_needs_cpu = needs_cpu_fallback();
            let mut comfy_args: Vec<&str> = vec![
                "main.py",
                "--listen", "127.0.0.1",
                "--port", &port_str,
                "--enable-cors-header", "*",
            ];
            if auto_needs_cpu {
                comfy_args.push("--cpu");
                println!("[ComfyUI] Auto-start: no NVIDIA driver — passing --cpu");
            }
            let mut cmd = Command::new(&python);
            cmd.args(&comfy_args)
                .current_dir(&path)
                .env("TQDM_DISABLE", "1")
                .env("PYTHONUNBUFFERED", "1")
                // Windows UTF-8 fix — see start_comfyui (plum133 2026-06-07):
                // prevents the cp1252 'charmap' UnicodeEncodeError crash when
                // ComfyUI prints Unicode progress glyphs to the piped stdout.
                .env("PYTHONIOENCODING", "utf-8")
                .env("PYTHONUTF8", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.spawn() {
                Ok(mut child) => {
                    // Assign to Job Object so child dies when parent dies (even via Task Manager)
                    #[cfg(target_os = "windows")]
                    assign_to_kill_on_close_job(&child);

                    // Drain stdout/stderr in background threads to prevent buffer deadlock
                    if let Some(stdout) = child.stdout.take() {
                        std::thread::spawn(move || {
                            use std::io::{BufRead, BufReader};
                            let reader = BufReader::new(stdout);
                            for line in reader.lines() {
                                if let Ok(line) = line {
                                    println!("[ComfyUI] {}", line);
                                }
                            }
                        });
                    }
                    if let Some(stderr) = child.stderr.take() {
                        std::thread::spawn(move || {
                            use std::io::{BufRead, BufReader};
                            let reader = BufReader::new(stderr);
                            for line in reader.lines() {
                                if let Ok(line) = line {
                                    println!("[ComfyUI] {}", line);
                                }
                            }
                        });
                    }

                    *state.comfy_process.lock().unwrap() = Some(child);
                    println!("[ComfyUI] Started");
                }
                Err(e) => println!("[ComfyUI] Failed to start: {}", e),
            }
        }
        None => println!("[ComfyUI] Not found. Install ComfyUI or set path in settings."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Bug J: needs_cpu_fallback platform short-circuit ─────────────────

    #[test]
    fn needs_cpu_fallback_is_false_on_macos() {
        // On macOS, PyTorch uses MPS and never calls cuda APIs that crash
        // the way Linux+no-NVIDIA does. The fallback must be a no-op there
        // so we don't downgrade real Mac users (M1/M2/etc) to CPU inference.
        if cfg!(target_os = "macos") {
            assert!(!needs_cpu_fallback(), "macOS must short-circuit to false");
        } else {
            // On non-macOS, the result depends on whether nvidia-smi is
            // installed + returns success. The function is total — it must
            // not panic in either branch. We just call it and assert it
            // returns a bool (compiler-enforced anyway).
            let _ = needs_cpu_fallback();
        }
    }

    #[test]
    fn needs_cpu_fallback_is_deterministic_for_repeat_calls() {
        // Two consecutive calls must agree — no time-based or random
        // behaviour smuggled in (Bug J's fix probes nvidia-smi each call,
        // so if nvidia-smi state doesn't change, the answer doesn't either).
        let a = needs_cpu_fallback();
        let b = needs_cpu_fallback();
        assert_eq!(a, b, "needs_cpu_fallback returned inconsistent results");
    }
}
