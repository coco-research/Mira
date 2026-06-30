# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public issue.** Instead:

1. Use [GitHub's private vulnerability reporting](https://github.com/PurpleDoubleD/locally-uncensored/security/advisories/new), or
2. Reach out via the [Discord](https://locallyuncensored.com/discord) DM.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depends on severity, but we aim for patches within 2 weeks for critical issues

### In-Scope

Locally Uncensored runs entirely locally on your machine, so the attack surface is limited. We still take the following seriously:

- **XSS in the chat UI** — malicious model outputs that could execute scripts
- **Path traversal** — file access outside intended directories
- **ComfyUI API abuse** — unintended command execution through the ComfyUI bridge
- **Remote Access** — auth bypass, passcode brute-force, unauthorized chat dispatch over LAN or Cloudflare Tunnel
- **Dependency vulnerabilities** — outdated npm or Cargo packages with known CVEs

### Out of Scope

- Vulnerabilities in Ollama, ComfyUI, LM Studio, or other backends themselves (report to their maintainers)
- Issues that require physical access to the machine
- Social engineering attacks
- Antivirus false positives (see the next section)

---

## Antivirus & Browser False Positives

Some antivirus engines and browser SmartScreen prompts flag the Windows installer as suspicious or as a generic trojan. This is a **false positive** caused by heuristics, not actual malware. Reports we have seen so far:

- **ESET**: blocks the installer at run-time
- **Avast**: `Win32:NSIS_Error[Heur]` heuristic on the NSIS bootstrap
- **Microsoft SmartScreen**: "unrecognized app" warning on first run

### Why it happens

1. **The installer is not yet Authenticode-signed.** We sign the auto-update channel with a Tauri / minisign key (see below), but the NSIS `.exe` you download from GitHub Releases does not yet carry a Microsoft code-signing certificate. Without that certificate, every reputation-based heuristic starts at zero trust.
2. **The app pattern looks suspicious to behavioural scanners.** Locally Uncensored is a Tauri app (small Rust binary + WebView), packaged with NSIS, that on first run downloads and executes other binaries (Ollama, ComfyUI, model files, Python). That combination overlaps with the behavioural fingerprint of certain droppers, even though every download path is open-source and visible in the code (`src-tauri/src/commands/install.rs`, `src-tauri/src/commands/ollama.rs`).
3. **NSIS itself is a frequently-flagged installer format**, since some malware families have used NSIS in the past.

### What you can do as a user

- **Verify the source.** Only download from the [official GitHub Releases page](https://github.com/PurpleDoubleD/locally-uncensored/releases). Every release is built by GitHub Actions from public source on the `master` branch — see `.github/workflows/release.yml`.
- **Verify the SHA-256.** GitHub Releases lists the exact bytes uploaded. The same hash should appear on [VirusTotal](https://www.virustotal.com/) if you scan it yourself. The community has done this before — see [Discussion #25 (jbarkls, 7 scanners + OPSWAT deep scan, all clear)](https://github.com/PurpleDoubleD/locally-uncensored/discussions/25).
- **Verify the auto-update.** Once installed, `Settings → Updates` checks `latest.json` from GitHub Releases and validates the bundle signature against this minisign public key:
  ```
  RWRHseb4LudtbIpBRaMDxMpSLMq+1TqeULJS/HY2/eviNqnAXVVyGsDc
  ```
  If a malicious update were ever served, the signature check would fail and the update would be rejected.
- **Submit the false positive.** Antivirus vendors fix false positives quickly when users submit the file. Direct links:
  - [ESET](https://support.eset.com/en/kb141-submit-a-virus-spyware-or-suspicious-file-to-eset-virus-lab)
  - [Microsoft Defender](https://www.microsoft.com/en-us/wdsi/filesubmission)
  - [Avast / AVG](https://www.avast.com/false-positive-file-form.php)
  - [Bitdefender](https://www.bitdefender.com/consumer/support/answer/29358/)
  - [Kaspersky](https://opentip.kaspersky.com/?tab=fileupload)
  - [Norton / Symantec](https://submit.norton.com/falsepositive)
  - [McAfee](https://www.mcafee.com/threat-intelligence/disputed-detection.aspx)
- **Build it yourself.** AGPL-3.0 means you can clone the repo, run `npm ci && npm run tauri build`, and end up with the same installer your antivirus is flagging — but with your own signature surface. See `CONTRIBUTING.md` for the build steps.

### Code-signing roadmap

A proper Authenticode-signed installer is the long-term fix. Two paths are in flight:

- **SignPath.io OSS plan** — free EV code-signing for verified open-source projects. Application status: pending.
- **Self-funded EV certificate** — ~$300-600/year. On the list once the project justifies the cost.

The auto-update channel is already signed (minisign), so the trust path *after* you have a working install is intact. The first install is the only weak link, and it is the one we are working to close.

If you have experience with cross-signing, EV cert provisioning, or SignPath onboarding — please get in touch via the Discord.
