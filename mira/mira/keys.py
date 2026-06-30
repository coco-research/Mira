"""Local secret loading — reads `.env` from the project dir. Never synced (SECURITY.md).

The whole point: an adapter checks `has("X_API_KEY")`; if present it goes live, else
it falls back to the free/offline path. So a missing key downgrades gracefully — it
never hard-crashes the pipeline.
"""
from __future__ import annotations

import os
from pathlib import Path
from .config import PROJECT_DIR

# Every key the system knows about (mirrors .env.example + SCHEMA.md §2).
KNOWN_KEYS = (
    # LLM pool
    "GEMINI_API_KEY", "NIM_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
    "GROQ_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN",
    "GITHUB_MODELS_TOKEN", "HUGGINGFACE_TOKEN",
    # media / voice / stock
    "PEXELS_API_KEY", "PIXABAY_API_KEY", "FREESOUND_TOKEN", "SARVAM_API_KEY",
    "ELEVENLABS_API_KEY", "SUNO_API_KEY", "MUAPI_KEY",
    # posting
    "YOUTUBE_CLIENT_SECRET_JSON", "YOUTUBE_API_KEY", "IG_ACCESS_TOKEN", "BLOTATO_API_KEY",
    # cloud burst
    "VULTR_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    # pod / local
    "SUPABASE_URL", "SUPABASE_AGENT_KEY", "MIRA_LOCAL_TOKEN",
)

_cache: dict[str, str] | None = None


def _parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def load(env_path: Path | None = None, *, refresh: bool = False) -> dict[str, str]:
    """Merge process env over a .env file. Cached unless refresh=True."""
    global _cache
    if _cache is not None and not refresh and env_path is None:
        return _cache
    merged = _parse_env(env_path or (PROJECT_DIR / ".env"))
    for k in KNOWN_KEYS:
        if os.environ.get(k):
            merged[k] = os.environ[k]
    if env_path is None:
        _cache = merged
    return merged


def get(name: str, default: str | None = None, env_path: Path | None = None) -> str | None:
    return load(env_path).get(name, default)


def has(name: str, env_path: Path | None = None) -> bool:
    v = get(name, env_path=env_path)
    return bool(v and v.strip())


def missing(names, env_path: Path | None = None) -> list[str]:
    return [n for n in names if not has(n, env_path=env_path)]


def configured(env_path: Path | None = None) -> dict[str, bool]:
    """{key: is_set} for every known key — drives the Connections status dots."""
    return {k: has(k, env_path=env_path) for k in KNOWN_KEYS}
