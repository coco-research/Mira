//! Local neural Text-to-Speech via Piper (rhasspy/piper, `piper-tts` on PyPI).
//!
//! 100% local — no cloud. We shell out to the same Python LU installs
//! faster-whisper into (ComfyUI venv → system Python) running the Piper CLI
//! one-shot per utterance: `python -m piper -m voice.onnx -c voice.onnx.json
//! -f out.wav` with the text on stdin. One-shot (vs a persistent server) costs
//! ~1-2 s of ONNX model load per "speak", which is acceptable for chat TTS and
//! avoids a long-lived process + version-specific Python API. Voice models are
//! downloaded on demand into `<app_data>/piper_voices/`.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine;
use tauri::{Manager, State};

use crate::state::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The default Piper voice LU downloads + speaks with. Medium-quality English,
/// ~63 MB. Files land in `<app_data>/piper_voices/`.
pub const PIPER_VOICE: &str = "en_US-lessac-medium";

/// Reject voice names that aren't a plain Piper voice id (defence-in-depth — the
/// name is interpolated into a download URL + a file path). Real ids look like
/// `en_US-lessac-medium` / `en_GB-alba-medium`.
fn is_valid_voice(voice: &str) -> bool {
    !voice.is_empty()
        && voice.len() < 64
        && voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn piper_voices_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", e))?
        .join("piper_voices");
    Ok(dir)
}

/// `(model.onnx, model.onnx.json)` for a voice id under the piper_voices dir.
pub fn piper_voice_paths(app: &tauri::AppHandle, voice: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = piper_voices_dir(app)?;
    Ok((
        dir.join(format!("{}.onnx", voice)),
        dir.join(format!("{}.onnx.json", voice)),
    ))
}

/// Whether neural TTS is usable: `import piper` succeeds AND the DEFAULT voice
/// model is present. The Settings badge + the chat SpeakerButton gate on this.
#[tauri::command]
pub fn tts_status(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let python = crate::commands::install::resolve_lu_python(state.inner());

    let mut piper_importable = false;
    if !python.is_empty() && crate::python::is_real_python(&python) {
        let mut cmd = Command::new(&python);
        cmd.args(["-c", "import piper"]).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        piper_importable = cmd.output().map(|o| o.status.success()).unwrap_or(false);
    }

    let voice_ready = piper_voice_paths(&app, PIPER_VOICE).map(|(onnx, _)| onnx.exists()).unwrap_or(false);

    Ok(serde_json::json!({
        "available": piper_importable && voice_ready,
        "piper": piper_importable,
        "voice": voice_ready,
    }))
}

/// Voice ids already downloaded under the piper_voices dir (file stems of the
/// `*.onnx` models). The Settings picker marks these as installed.
#[tauri::command]
pub fn installed_piper_voices(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = match piper_voices_dir(&app) {
        Ok(d) => d,
        Err(_) => return Ok(vec![]),
    };
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".onnx") {
                out.push(stem.to_string());
            }
        }
    }
    Ok(out)
}

/// Download a specific Piper voice model into the piper_voices dir. Blocking —
/// the frontend awaits it with a spinner (no separate progress channel; a voice
/// is ~63 MB). Idempotent: re-downloading an existing voice just no-ops fast.
#[tauri::command]
pub fn download_voice(
    voice: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if !is_valid_voice(&voice) {
        return Err(format!("invalid voice id: {}", voice));
    }
    let python = crate::commands::install::resolve_lu_python(state.inner());
    if python.is_empty() || !crate::python::is_real_python(&python) {
        return Err("no_python: install Python first.".to_string());
    }
    let dir = piper_voices_dir(&app)?;
    let _ = std::fs::create_dir_all(&dir);

    let mut cmd = Command::new(&python);
    cmd.args([
        "-m",
        "piper.download_voices",
        &voice,
        "--download-dir",
        &dir.to_string_lossy(),
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("could not start voice download: {}", e))?;
    if !output.status.success() {
        return Err(format!("voice download failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let (onnx, _) = piper_voice_paths(&app, &voice)?;
    if !onnx.exists() {
        return Err("voice download reported success but the model is missing".to_string());
    }
    Ok(serde_json::json!({ "ok": true, "voice": voice }))
}

/// Synthesize `text` to a WAV and return it base64-encoded for the frontend to
/// play. `voice` is an optional Piper voice id (defaults to PIPER_VOICE). Runs
/// the Piper CLI one-shot.
#[tauri::command]
pub fn synthesize(
    text: String,
    voice: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".to_string());
    }

    let voice = match voice {
        Some(v) if is_valid_voice(&v) => v,
        _ => PIPER_VOICE.to_string(),
    };

    let python = crate::commands::install::resolve_lu_python(state.inner());
    if python.is_empty() || !crate::python::is_real_python(&python) {
        return Err("no_python: install Python first.".to_string());
    }

    let (onnx, config) = piper_voice_paths(&app, &voice)?;
    if !onnx.exists() || !config.exists() {
        return Err(format!(
            "no_voice: the '{}' voice isn't downloaded — pick/install it in Settings → Voice & Remote.",
            voice
        ));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_wav = std::env::temp_dir().join(format!("lu-tts-{}.wav", stamp));

    let mut cmd = Command::new(&python);
    cmd.args([
        "-m",
        "piper",
        "-m",
        &onnx.to_string_lossy(),
        "-c",
        &config.to_string_lossy(),
        "-f",
        &out_wav.to_string_lossy(),
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start piper: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
        // dropped at end of block → stdin closed so piper proceeds
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("piper wait failed: {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&out_wav);
        return Err(format!(
            "piper synthesis failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let bytes = std::fs::read(&out_wav).map_err(|e| format!("read wav: {}", e))?;
    let _ = std::fs::remove_file(&out_wav);
    if bytes.is_empty() {
        return Err("piper produced an empty WAV".to_string());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({ "audio_base64": b64, "mime": "audio/wav" }))
}

/// Synthesize `text` via a user-configured external HTTP TTS engine and return
/// it base64-encoded for the frontend to play (GitHub #58). The endpoint is an
/// OpenAI-compatible `/v1/audio/speech` URL — e.g. Kokoro-FastAPI on
/// `http://localhost:8880/v1/audio/speech`, or any OpenAI-compatible TTS server.
///
/// SSRF note: unlike `proxy::fetch_external`, this deliberately does NOT run the
/// localhost/private-IP block. The endpoint comes from the Settings UI (the
/// user's own voice config), never from model output or chat content, so there
/// is no attacker-controlled-URL vector — and pointing at a LOCAL engine
/// (localhost:8880) is the entire point, exactly like LU's local Ollama /
/// ComfyUI / LM Studio connections.
#[tauri::command]
pub async fn synthesize_external(
    text: String,
    url: String,
    voice: Option<String>,
) -> Result<serde_json::Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".to_string());
    }

    // Light validation only — must be a well-formed http(s) URL. Localhost/LAN
    // is allowed on purpose (see the SSRF note above).
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("invalid TTS endpoint URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("TTS endpoint must be http or https, got '{}'", other)),
    }

    // OpenAI-compatible engines require a voice. Default to OpenAI's "alloy";
    // Kokoro users set their own (e.g. "af_bella") in Settings.
    let voice = voice
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "alloy".to_string());

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // OpenAI-compatible TTS request body. Kokoro-FastAPI + OpenAI both accept it.
    let body = serde_json::json!({
        "model": "tts-1",
        "input": text,
        "voice": voice,
        "response_format": "wav",
    });

    let resp = client
        .post(parsed.as_str())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("external TTS request failed: {}", e))?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let detail = resp.text().await.unwrap_or_default();
        let snippet: String = detail.chars().take(200).collect();
        return Err(format!("external TTS HTTP {}: {}", code, snippet));
    }

    // Honor whatever audio type the engine returns (wav/mp3/…). The browser
    // <audio> element plays both from a data URL, so pass the Content-Type
    // through as the mime instead of forcing a single format.
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        .filter(|s| s.starts_with("audio/"))
        .unwrap_or_else(|| "audio/wav".to_string());

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("external TTS returned no audio".to_string());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({ "audio_base64": b64, "mime": mime }))
}
