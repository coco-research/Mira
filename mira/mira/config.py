"""Local config + paths. Secrets stay on disk (.env), never synced (SECURITY.md)."""
from __future__ import annotations

import os
from pathlib import Path

try:
    import tomllib  # py3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

PKG_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PKG_DIR.parent                      # the mira/ project dir
STATE_DIR = Path(os.environ.get("MIRA_STATE_DIR", PROJECT_DIR / "state"))
COST_LOG = STATE_DIR / "cost_log.json"
COST_MODEL = STATE_DIR / "cost_model.json"

# Cloned render-engine repos (key-free designed visuals). Overridable via env.
REPOS_DIR = Path(os.environ.get("MIRA_REPOS_DIR", PROJECT_DIR.parent / "repos"))
OPENMONTAGE_DIR = REPOS_DIR / "OpenMontage"        # Remotion composer lives here
REMOTION_COMPOSER_DIR = OPENMONTAGE_DIR / "remotion-composer"

# Default visual engine for the pipeline: cards | remotion | hyperframes.
# "cards" is the always-available offline ffmpeg fallback.
VISUAL_ENGINE = os.environ.get("MIRA_VISUAL_ENGINE", "cards")

# Homebrew bin holds ffmpeg/ffprobe but is often off the default PATH; render
# subprocesses (npx remotion / npx hyperframes) need it discoverable.
HOMEBREW_BIN = "/opt/homebrew/bin"

# Default provider base URLs (overridable in config.toml).
DEFAULT_BASE_URLS = {
    "lmstudio": "http://localhost:1234/v1",
    "comfyui": "http://localhost:8188",
    "nim": "https://integrate.api.nvidia.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "mistral": "https://api.mistral.ai/v1",
    "groq": "https://api.groq.com/openai/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}

# Localhost ports the probe checks for running local engines.
LOCAL_PORTS = {"lmstudio": 1234, "comfyui": 8188}


def ensure_state_dir() -> Path:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    return STATE_DIR


def load_config(path: Path | None = None) -> dict:
    """Load config.toml if present; otherwise sensible defaults."""
    cfg = {
        "base_urls": dict(DEFAULT_BASE_URLS),
        "budget_cap_usd": 50.0,
        "burst_budget_usd": 20.0,
        "allow_cloud_burst": True,
        "tier_override": None,
    }
    p = path or (PROJECT_DIR / "config.toml")
    if p.exists() and tomllib is not None:
        with open(p, "rb") as fh:
            user = tomllib.load(fh)
        cfg.update(user)
        if "base_urls" in user:
            merged = dict(DEFAULT_BASE_URLS)
            merged.update(user["base_urls"])
            cfg["base_urls"] = merged
    return cfg
