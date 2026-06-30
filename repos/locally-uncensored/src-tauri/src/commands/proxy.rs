use tauri::Emitter;

/// Validate that an external URL is safe to fetch (no SSRF).
/// Blocks private IP ranges, non-HTTP schemes, and localhost.
fn validate_external_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    // Only allow http and https
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Blocked scheme: {}", other)),
    }

    let host = parsed.host_str().unwrap_or("");

    // Block localhost variants
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        || host == "0.0.0.0" || host.ends_with(".localhost")
    {
        return Err("Blocked: localhost access not allowed for external fetch".into());
    }

    // Block private/reserved IPv4 ranges
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        let octets = ip.octets();
        let blocked = matches!(octets,
            [10, ..] |                                          // 10.0.0.0/8
            [172, 16..=31, ..] |                                // 172.16.0.0/12
            [192, 168, ..] |                                    // 192.168.0.0/16
            [127, ..] |                                         // 127.0.0.0/8
            [169, 254, ..] |                                    // 169.254.0.0/16 (link-local)
            [0, ..]                                             // 0.0.0.0/8
        );
        if blocked {
            return Err(format!("Blocked: private/reserved IP {}", ip));
        }
    }

    // Block private IPv6 (fc00::/7, fe80::/10, ::1)
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::Ipv6Addr>() {
        let segments = ip.segments();
        let blocked = ip.is_loopback()
            || (segments[0] & 0xfe00) == 0xfc00   // fc00::/7 (unique local)
            || (segments[0] & 0xffc0) == 0xfe80;  // fe80::/10 (link-local)
        if blocked {
            return Err(format!("Blocked: private/reserved IPv6 {}", ip));
        }
    }

    Ok(())
}

/// Generic HTTP proxy — fetch any external URL and return body as string.
/// Used for CivitAI API calls, workflow JSON downloads, etc.
#[tauri::command]
pub async fn fetch_external(url: String) -> Result<String, String> {
    validate_external_url(&url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch_external: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url));
    }

    resp.text().await.map_err(|e| e.to_string())
}

/// Binary HTTP proxy — fetch any external URL and return bytes.
/// Used for downloading ZIP files, images, model files.
#[tauri::command]
pub async fn fetch_external_bytes(url: String) -> Result<Vec<u8>, String> {
    validate_external_url(&url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch_external_bytes: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Extract the host from `ollama_base` + `comfy_host` so we can allow-list
/// user-configured remote backends through the CORS proxy. Returns a
/// lowercase host string (or empty if the configured URL is malformed).
fn configured_host(url_or_host: &str) -> String {
    // ollama_base is always stored as a full URL (see load_ollama_base); try
    // that parse first.
    if let Ok(u) = url::Url::parse(url_or_host) {
        if let Some(h) = u.host_str() {
            return h.to_lowercase();
        }
    }
    // comfy_host is stored as a bare hostname/IP.
    url_or_host.trim().to_lowercase()
}

/// Fold an address to its IPv4 form, collapsing IPv4-mapped (`::ffff:a.b.c.d`)
/// and IPv4-compatible (`::a.b.c.d`) IPv6 down to v4 — so the metadata/LAN checks
/// can't be bypassed by encoding the address as IPv6 (e.g.
/// `::ffff:169.254.169.254` resolves on the v4 stack). `host` must be already
/// bracket-stripped + lowercased.
fn as_ipv4(host: &str) -> Option<std::net::Ipv4Addr> {
    match host.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V4(v4) => Some(v4),
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().or_else(|| v6.to_ipv4()),
    }
}

/// Cloud-metadata / link-local addresses that must NEVER be proxied, even if a
/// host somehow lands in an allow-list. The classic SSRF targets (AWS/GCP/Azure
/// 169.254.169.254, Alibaba 100.100.100.200, GCP IPv6 IMDS fd00:ec2::254) plus
/// the whole IPv4 link-local block — a real LAN LLM backend never lives there.
/// Defense-in-depth on top of host registration (Bug A; hardened for
/// IPv4-mapped-IPv6 bypass M1).
fn is_blocked_proxy_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    // GCP IPv6 IMDS literal (a genuine IPv6 address, not a mapped-v4 form).
    if h == "fd00:ec2::254" {
        return true;
    }
    // Fold v4 + IPv4-mapped/compatible v6 to v4, then block link-local + the
    // known metadata IPs (so ::ffff:169.254.169.254 / ::ffff:6464:64c8 etc. can't
    // slip past the v4 string/parse checks).
    if let Some(v4) = as_ipv4(&h) {
        let o = v4.octets();
        if o[0] == 169 && o[1] == 254 {     // 169.254.0.0/16 incl. AWS/GCP/Azure IMDS
            return true;
        }
        if o == [100, 100, 100, 200] {       // Alibaba IMDS
            return true;
        }
    }
    false
}

/// True only for private/LAN hosts a user could legitimately point a local
/// backend at. `register_openai_host` requires this so the RUST boundary — not
/// the JS caller — enforces the LAN-only intent and can't be tricked into
/// allow-listing arbitrary public/intranet hosts (SSRF hardening M2). Mirrors
/// the frontend `isPrivateOrLanHost`. Input must be bracket-stripped+lowercased.
fn is_registerable_lan_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    if h.is_empty() {
        return false;
    }
    if matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || h.ends_with(".localhost")
    {
        return true;
    }
    if h.ends_with(".local") || h.ends_with(".lan") || h.ends_with(".internal")
        || h.ends_with(".intra") || h.ends_with(".home") || h.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        if let Some(v4) = as_ipv4(&h) {
            let o = v4.octets();
            // 169.254/16 (link-local) + public ranges → false; RFC1918 + CGNAT → true.
            return (o[0] == 10)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 127)
                || (o[0] == 100 && (64..=127).contains(&o[1]));
        }
        if let std::net::IpAddr::V6(v6) = ip {
            let s = v6.segments();
            return (s[0] & 0xfe00) == 0xfc00   // fc00::/7 ULA
                || (s[0] & 0xffc0) == 0xfe80;   // fe80::/10 link-local
        }
        return false;
    }
    // Bare single-label machine name (no dots, no stray ':') = LAN host.
    !h.contains('.') && !h.contains(':')
}

/// Validate that a URL targets either localhost or one of the user-configured
/// backend hosts (Ollama via `ollama_base`, ComfyUI via `comfy_host`).
///
/// SSRF policy: the proxy only forwards to hosts the user explicitly pointed
/// LU at. A JS-level compromise still cannot reach arbitrary intranet
/// services; it can only reach the host the user already wanted to reach.
fn validate_proxy_url(raw: &str, state: &crate::state::AppState) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Blocked scheme: {}", other)),
    }

    let host = parsed.host_str().unwrap_or("").to_lowercase();

    // Hard block: cloud-metadata / link-local — never proxied, even if a host
    // somehow got allow-listed (SSRF defense-in-depth, Bug A).
    if is_blocked_proxy_host(&host) {
        return Err(format!(
            "Blocked: '{}' is a metadata/link-local address and is never proxied", host
        ));
    }

    // Always-allowed: localhost variants. Covers the common case + any
    // backend bound to 0.0.0.0 on the same machine.
    let is_local = matches!(host.as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]" | "0.0.0.0"
    ) || host.ends_with(".localhost");
    if is_local {
        return Ok(());
    }

    // Configured Ollama host (Issue #31: users with OLLAMA_HOST=192.168.x.x).
    let ollama_host = state.ollama_base.lock()
        .ok()
        .map(|g| configured_host(&g))
        .unwrap_or_default();
    if !ollama_host.is_empty() && host == ollama_host {
        return Ok(());
    }

    // Configured ComfyUI host (v2.3.6 feature).
    let comfy_host = state.comfy_host.lock()
        .ok()
        .map(|g| configured_host(&g))
        .unwrap_or_default();
    if !comfy_host.is_empty() && host == comfy_host {
        return Ok(());
    }

    // Configured OpenAI-compatible LAN backends (Bug A / GH #49). Registered
    // via `register_openai_host` when the provider points at a non-localhost
    // host. Only these specific user-configured hosts are forwarded.
    if let Ok(hosts) = state.openai_hosts.lock() {
        if hosts.contains(&host) {
            return Ok(());
        }
    }

    Err(format!(
        "proxy_localhost: host '{}' not allowed. Configure remote backends via Settings → Providers or Settings → ComfyUI (Host).",
        host
    ))
}

/// Register a user-configured OpenAI-compatible backend host (LAN LM Studio,
/// vLLM, …) into the proxy allow-list so `proxy_localhost` will forward to it.
/// Mirrors the Ollama/ComfyUI host-registration model (Bug A / GH #49): the
/// webview CSP + the backend's CORS block a direct LAN fetch, so these requests
/// are proxied through Rust instead.
///
/// SSRF policy: only the host the user explicitly pointed LU at is added, and
/// metadata/link-local addresses are refused outright (defense-in-depth on top
/// of validate_proxy_url's hard block). Accepts a bare host or a full URL.
#[tauri::command]
pub fn register_openai_host(
    host: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let h = configured_host(&host);
    if h.is_empty() || h.contains('/') || h.contains(' ') {
        return Err("invalid host".to_string());
    }
    if is_blocked_proxy_host(&h) {
        return Err(format!("refused: '{}' is a metadata/link-local address", h));
    }
    // SSRF hardening (M2): only allow-list private/LAN hosts. The Rust boundary
    // enforces the LAN-only intent rather than trusting the JS caller — public
    // endpoints don't need the proxy (they use a direct fetch).
    if !is_registerable_lan_host(&h) {
        return Err(format!("refused: '{}' is not a private/LAN host", h));
    }
    if let Ok(mut hosts) = state.openai_hosts.lock() {
        // Bound the set (m1) — defend against a runaway registration loop.
        if hosts.len() >= 64 && !hosts.contains(&h) {
            return Err("too many registered hosts".to_string());
        }
        hosts.insert(h);
    }
    Ok(())
}

/// Generic localhost proxy — fetch any localhost or configured-backend URL
/// bypassing CORS. Used for Ollama and ComfyUI API calls in production mode.
///
/// `timeout_ms` (optional) overrides the default 300 s timeout. Backend
/// detection passes 2000 — without that override the onboarding "Searching
/// for local backends..." step would freeze for 5 minutes whenever a port
/// happens to be answered by software that takes the TCP connect but
/// never replies HTTP (Discord report — Docker dev container on 8000,
/// firewall throttling, another LLM tool with a slow health endpoint, ...).
/// Long-running calls (Ollama pull, ComfyUI generate) keep the 300 s default.
#[tauri::command]
pub async fn proxy_localhost(
    url: String,
    method: Option<String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    validate_proxy_url(&url, &state)?;

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request.header("Content-Type", "application/json").body(body_str);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.text().await.map_err(|e| e.to_string())
}

/// Streaming localhost proxy — BUFFERS the whole body (no streaming). Kept for
/// non-streaming callers (e.g. proxy-download). For chat, use the chunked variant
/// below so a long generation doesn't look like a multi-minute "model loading" hang.
#[tauri::command]
pub async fn proxy_localhost_stream(url: String, method: Option<String>, body: Option<String>, state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<u8>, String> {
    validate_proxy_url(&url, &state)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request.header("Content-Type", "application/json").body(body_str);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost_stream: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Chunked streaming localhost proxy for Ollama chat (David 2026-06-02).
///
/// The webview CANNOT fetch Ollama directly — its origin is `http://tauri.localhost`
/// and Ollama's CORS rejects it ("TypeError: Failed to fetch"), so ALL chat traffic
/// is routed through the proxy. The buffered `proxy_localhost_stream` awaits the
/// ENTIRE body (2-hour timeout), so a long/slow generation produced NOTHING in the UI
/// until fully finished — a multi-minute "model loading"/hang (dhasim Discord report).
/// This variant forwards each chunk to the caller's `on_chunk` Channel as it arrives
/// → true token-by-token streaming. (`Channel` must be a required arg — wrapping it in
/// `Option` does not implement `Deserialize`, hence a separate command.)
#[tauri::command]
pub async fn proxy_localhost_stream_chunked(
    url: String,
    method: Option<String>,
    body: Option<String>,
    on_chunk: tauri::ipc::Channel<Vec<u8>>,
    // Optional id so the JS side can deterministically cancel THIS stream via
    // `cancel_proxy_stream(stream_id)`. Without it, aborting only broke the JS
    // read-loop while Ollama kept generating to completion on the proxy path
    // (David 2026-06-15: deleting/Stopping a chat must stop the backend too).
    stream_id: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    validate_proxy_url(&url, &state)?;

    // Register a cancellation token under stream_id (mirrors pull_tokens).
    let token = tokio_util::sync::CancellationToken::new();
    let registry = state.stream_tokens.clone();
    if let Some(id) = stream_id.as_ref() {
        if let Some(old) = registry.lock().unwrap().insert(id.clone(), token.clone()) {
            old.cancel(); // a stale stream under the same id — cancel it first
        }
    }

    // Run the actual proxying in an inner future so we can always clean the
    // token out of the registry afterwards, regardless of how we exit.
    let run = async move {
        let client = reqwest::Client::builder()
            .user_agent("LocallyUncensored/2.0")
            .timeout(std::time::Duration::from_secs(7200))
            .build()
            .map_err(|e| e.to_string())?;

        let http_method = method.unwrap_or_else(|| "GET".to_string());

        let mut request = match http_method.as_str() {
            "POST" => client.post(&url),
            "DELETE" => client.delete(&url),
            "PUT" => client.put(&url),
            _ => client.get(&url),
        };

        if let Some(body_str) = body {
            request = request.header("Content-Type", "application/json").body(body_str);
        }

        // Race the request against cancellation even during connect/headers.
        let resp = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            r = request.send() => r.map_err(|e| format!("proxy_localhost_stream_chunked: {}", e))?,
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, text));
        }

        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        loop {
            tokio::select! {
                // Stop fires → drop `stream`/`resp` → the HTTP connection closes
                // → Ollama stops generating (frees the GPU). This is the fix.
                _ = token.cancelled() => break,
                item = stream.next() => match item {
                    Some(it) => {
                        let bytes = it.map_err(|e| e.to_string())?;
                        if bytes.is_empty() { continue; }
                        // JS side gone (reader cancelled / window closed) → stop.
                        if on_chunk.send(bytes.to_vec()).is_err() { break; }
                    }
                    None => break,
                }
            }
        }
        // Explicit EOF marker (empty chunk — data chunks are never empty, the
        // loop above skips them). The JS side closes its ReadableStream on THIS,
        // not on the command's return: WebView2 149 delivers queued channel
        // messages AFTER the invoke result resolves (live find 2026-06-11), so
        // closing on the result raced ahead of the data and silently dropped
        // every chunk — chats showed the user message but never a reply.
        let _ = on_chunk.send(Vec::new());
        Ok(())
    }
    .await;

    if let Some(id) = stream_id.as_ref() {
        registry.lock().unwrap().remove(id);
    }
    run
}

/// Cancel an in-flight `proxy_localhost_stream_chunked` by its stream id. Fired
/// from the JS side when the user hits Stop or deletes/closes a chat, so the
/// upstream Ollama request is actually aborted (not just the JS read-loop).
#[tauri::command]
pub fn cancel_proxy_stream(
    state: tauri::State<'_, crate::state::AppState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(token) = state.stream_tokens.lock().unwrap().remove(&stream_id) {
        token.cancel();
    }
    Ok(())
}

/// Upload an image to ComfyUI's `/upload/image` as a clean multipart POST from
/// Rust. `uploadImage()` in the frontend used a RAW browser `fetch()` — the only
/// non-proxy fetch left — which 400'd on some WebView2 builds (multipart /
/// boundary / CORS-preflight quirks; konata 2026-06-14 "Failed to upload image:
/// HTTP 400"). reqwest's multipart is machine-independent and removes WebView2
/// as a variable, matching the "everything via the Rust proxy" pattern
/// (WebView2-149 finding). Returns ComfyUI's JSON body ({ name, subfolder, type }).
#[tauri::command]
pub async fn comfy_upload_image(
    url: String,
    filename: String,
    content_type: Option<String>,
    file_bytes: Vec<u8>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    validate_proxy_url(&url, &state)?;
    if file_bytes.is_empty() {
        return Err("the source image is empty (0 bytes)".to_string());
    }
    let ct = content_type.filter(|c| !c.is_empty()).unwrap_or_else(|| "image/png".to_string());
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str(&ct)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", "true");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.post(&url).multipart(form).send().await
        .map_err(|e| format!("comfy_upload_image: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body.trim()));
    }
    Ok(body)
}

/// Streaming Ollama model pull — emits per-model progress events.
/// Each event is a JSON object: { "model": "name", "data": { ...ollama progress... } }
#[tauri::command]
pub async fn pull_model_stream(app: tauri::AppHandle, state: tauri::State<'_, crate::state::AppState>, name: String) -> Result<(), String> {
    use futures_util::StreamExt;

    // Create cancellation token for this pull
    let token = tokio_util::sync::CancellationToken::new();
    {
        let mut tokens = state.pull_tokens.lock().unwrap();
        // Cancel any existing pull for same model
        if let Some(old) = tokens.remove(&name) {
            old.cancel();
        }
        tokens.insert(name.clone(), token.clone());
    }

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;

    // Route to the configured Ollama base (Issue #31 — was hardcoded
    // http://localhost:11434 so remote Ollama hosts never got the pull).
    let ollama_base = state.ollama_base.lock().ok()
        .map(|g| g.clone())
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let pull_url = format!("{}/api/pull", ollama_base.trim_end_matches('/'));

    let resp = client
        .post(&pull_url)
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"name":"{}","stream":true}}"#, name))
        .send()
        .await
        .map_err(|e| format!("pull_model_stream: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        state.pull_tokens.lock().unwrap().remove(&name);
        return Err(format!("HTTP {}: {}", status, text));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    let mut was_cancelled = false;
    // Bug Z/a v2.5.0 — leonsk29 GH #48. We need to know whether the stream
    // ever produced a terminal "success" line, OR whether it produced an
    // `error` field. Ollama 0.4+ responds to a broken HF reference (e.g.
    // bartowski/Hermes-3 GGUF on llama.cpp-incompatible builds) with HTTP
    // 200 + a stream that ends after emitting `{"status":"pulling manifest"}`
    // (no error field, no `success` line). Pre-v2.5.0 we treated that as
    // success and the frontend flipped the badge to "Completed" despite no
    // blob being written. Now we track the last status + watch for any
    // `error` field, and surface a real error to the caller if neither
    // success nor an explicit error came in.
    let mut last_status: Option<String> = None;
    let mut saw_success = false;
    let mut error_msg: Option<String> = None;

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                was_cancelled = true;
                break;
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buffer.find('\n') {
                            let line = buffer[..pos].trim().to_string();
                            buffer = buffer[pos + 1..].to_string();
                            if !line.is_empty() {
                                // Bug Z/a — inspect each line for status/error fields
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                                    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                                        error_msg = Some(err.to_string());
                                    }
                                    if let Some(st) = parsed.get("status").and_then(|v| v.as_str()) {
                                        last_status = Some(st.to_string());
                                        if st == "success" {
                                            saw_success = true;
                                        }
                                    }
                                }
                                // Emit with model name so frontend can route
                                let payload = format!(r#"{{"model":"{}","data":{}}}"#, name, line);
                                let _ = app.emit("pull-progress", &payload);
                            }
                        }
                    }
                    Some(Err(e)) => {
                        let _ = app.emit("pull-progress", &format!(
                            r#"{{"model":"{}","data":{{"status":"Error: {}"}}}}"#, name, e
                        ));
                        error_msg = Some(format!("network: {}", e));
                        break;
                    }
                    None => break, // Stream finished
                }
            }
        }
    }

    // Flush remaining (only if not cancelled)
    if !was_cancelled {
        let remaining = buffer.trim().to_string();
        if !remaining.is_empty() {
            // Same status/error inspection for the flushed tail
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&remaining) {
                if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                    error_msg = Some(err.to_string());
                }
                if let Some(st) = parsed.get("status").and_then(|v| v.as_str()) {
                    last_status = Some(st.to_string());
                    if st == "success" {
                        saw_success = true;
                    }
                }
            }
            let payload = format!(r#"{{"model":"{}","data":{}}}"#, name, remaining);
            let _ = app.emit("pull-progress", &payload);
        }
    }

    // Cleanup token
    state.pull_tokens.lock().unwrap().remove(&name);

    if was_cancelled {
        return Err("cancelled".to_string());
    }

    // Bug Z/a v2.5.0 — only declare success if Ollama actually said so. If
    // the stream ended without `{"status":"success"}` and without an
    // explicit error field, surface the last status as the failure reason
    // (e.g. "stream ended at: pulling manifest"). The frontend's catch
    // will now show this to the user instead of silently flipping to
    // "Completed".
    if let Some(err) = error_msg {
        Err(format!("ollama: {}", err))
    } else if saw_success {
        Ok(())
    } else {
        let tail = last_status.unwrap_or_else(|| "no status received".to_string());
        Err(format!("pull did not complete: stream ended at \"{}\". Repo may be incompatible with llama.cpp (try a different GGUF mirror).", tail))
    }
}

/// Cancel an active Ollama model pull
#[tauri::command]
pub fn cancel_model_pull(state: tauri::State<'_, crate::state::AppState>, name: String) -> Result<(), String> {
    let mut tokens = state.pull_tokens.lock().unwrap();
    if let Some(token) = tokens.remove(&name) {
        token.cancel();
        Ok(())
    } else {
        Ok(()) // Already finished or never started
    }
}

/// Proxy search requests to ollama.com (needed because frontend can't CORS to ollama.com)
#[tauri::command]
pub async fn ollama_search(query: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://ollama.com/search?q={}&p=1",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Ollama search: {}", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Try to parse as JSON; if it's HTML, return empty results
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(json) => Ok(json),
        Err(_) => Ok(serde_json::json!({"models": []})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_cloud_metadata_and_link_local() {
        // Classic SSRF metadata targets — must be blocked even if registered.
        assert!(is_blocked_proxy_host("169.254.169.254")); // AWS/GCP/Azure IMDS
        assert!(is_blocked_proxy_host("100.100.100.200")); // Alibaba
        assert!(is_blocked_proxy_host("fd00:ec2::254"));   // GCP IPv6 IMDS
        assert!(is_blocked_proxy_host("[fd00:ec2::254]")); // bracketed form
        // Whole IPv4 link-local 169.254.0.0/16.
        assert!(is_blocked_proxy_host("169.254.0.1"));
        assert!(is_blocked_proxy_host("169.254.255.255"));
    }

    #[test]
    fn allows_real_lan_and_localhost() {
        for h in ["192.168.1.50", "10.0.0.5", "172.16.4.4", "localhost",
                  "127.0.0.1", "100.64.0.1" /* Tailscale CGNAT, not metadata */] {
            assert!(!is_blocked_proxy_host(h), "{} should not be blocked", h);
        }
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6_metadata() {
        // M1: encoding the metadata IP as IPv4-mapped/compatible IPv6 must NOT
        // bypass the block.
        assert!(is_blocked_proxy_host("::ffff:169.254.169.254"));
        assert!(is_blocked_proxy_host("[::ffff:169.254.169.254]"));
        assert!(is_blocked_proxy_host("::ffff:a9fe:a9fe"));   // hex form of 169.254.169.254
        assert!(is_blocked_proxy_host("::ffff:6464:64c8"));   // 100.100.100.200 mapped
        assert!(is_blocked_proxy_host("fd00:ec2::254"));
        // Real LAN/global addresses are not metadata.
        assert!(!is_blocked_proxy_host("192.168.0.74"));
        assert!(!is_blocked_proxy_host("2606:4700::1111"));
    }

    #[test]
    fn register_only_private_lan_hosts() {
        // M2: public + junk hosts must NOT be registerable; private/LAN are.
        for ok in ["192.168.0.74", "10.0.0.5", "172.16.4.4", "localhost",
                   "127.0.0.1", "100.64.0.1", "nas", "box.lan", "fd00::1"] {
            assert!(is_registerable_lan_host(ok), "{} should be registerable", ok);
        }
        for bad in ["8.8.8.8", "api.openai.com", "attacker.com", "169.254.169.254",
                    "::ffff:169.254.169.254", "javascript:alert(1)", "2606:4700::1111",
                    "192.168.0.74:1234"] {
            assert!(!is_registerable_lan_host(bad), "{} should NOT be registerable", bad);
        }
    }

    #[test]
    fn configured_host_extracts_from_url_or_bare() {
        assert_eq!(configured_host("http://192.168.1.50:1234/v1"), "192.168.1.50");
        assert_eq!(configured_host("192.168.1.50"), "192.168.1.50");
        assert_eq!(configured_host("HTTP://Host.LAN:8080"), "host.lan");
        assert_eq!(configured_host("  nas  "), "nas");
    }
}
