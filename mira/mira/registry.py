"""Provider registry for the Mira Engines screen.

Stdlib-only.  Mirrors the "Engines matrix" in dashboard/partials/_CONTRACT.md
exactly.  All badge values are one of: Local | Free | Metered | Quota | mixed.
"""
from __future__ import annotations

from mira.schemas import STAGES, ProviderOption, StageMenu

# ---------------------------------------------------------------------------
# Raw definition: list-of-dicts so we stay JSON-serialisable from day one.
# Field order: id, label, badge, default (default omitted → False).
# ---------------------------------------------------------------------------
_RAW: dict[str, list[dict]] = {
    "script": [
        {"id": "lmstudio",       "label": "LM Studio local",                             "badge": "Local",    "default": True},
        {"id": "nim",            "label": "NVIDIA NIM — MiniMax-M3/Nemotron-3",           "badge": "Free"},
        {"id": "openrouter",     "label": "OpenRouter",                                   "badge": "Free"},
        {"id": "mistral",        "label": "Mistral La Plateforme",                        "badge": "Free"},
        {"id": "groq",           "label": "Groq",                                         "badge": "Free"},
        {"id": "cerebras",       "label": "Cerebras",                                     "badge": "Free"},
        {"id": "cloudflare",     "label": "Cloudflare Workers AI",                        "badge": "Free"},
        {"id": "github-models",  "label": "GitHub Models",                                "badge": "Free"},
        {"id": "huggingface",    "label": "HuggingFace local",                            "badge": "Local"},
        {"id": "gemini",         "label": "Gemini",                                       "badge": "Free"},
        {"id": "uncensored-local", "label": "Uncensored local — abliterated GGUF",        "badge": "Local"},
    ],
    "voice_en": [
        {"id": "edge-tts",   "label": "edge-tts",    "badge": "Free",    "default": True},
        {"id": "kokoro",     "label": "Kokoro local", "badge": "Local"},
        {"id": "elevenlabs", "label": "ElevenLabs",   "badge": "Metered"},
    ],
    "voice_hi": [
        {"id": "sarvam",      "label": "Sarvam",         "badge": "Metered", "default": True},
        {"id": "edge-tts-hi", "label": "edge-tts hi-IN", "badge": "Free"},
    ],
    "images": [
        {"id": "sdxl-flux",        "label": "local SDXL-Flux",              "badge": "Local", "default": True},
        {"id": "imagen",           "label": "Imagen",                        "badge": "Quota"},
        {"id": "gemini",           "label": "Gemini",                        "badge": "Free"},
        {"id": "nim-flux",         "label": "NIM FLUX/Qwen",                 "badge": "Free"},
        {"id": "uncensored-local", "label": "Uncensored local checkpoint",   "badge": "Local"},
    ],
    "ai_video": [
        {"id": "veo",         "label": "Veo on quota",                              "badge": "Quota",   "default": True},
        {"id": "comfyui-ltx", "label": "ComfyUI LTX Mac",                           "badge": "Local"},
        {"id": "seedance",    "label": "Seedance 2.0 Mini",                          "badge": "Metered"},
        {"id": "cloud-burst", "label": "Cloud-burst Vultr→AWS SkyReels-14B/Wan",    "badge": "Metered"},
    ],
    "motion": [
        {"id": "kling",       "label": "Kling 3 Turbo (Open-Generative-AI)", "badge": "Metered", "default": True},
        {"id": "wan2-animate","label": "Wan2.2-Animate local",               "badge": "Local"},
        {"id": "viggle",      "label": "Viggle",                              "badge": "Free"},
    ],
    "music": [
        {"id": "pixabay",   "label": "Pixabay/Freesound",  "badge": "Free",    "default": True},
        {"id": "music-gen", "label": "local music_gen",     "badge": "Local"},
        {"id": "suno",      "label": "Suno",                "badge": "Metered"},
    ],
    "thumbnail_metadata": [
        {"id": "imagen-flux-llm", "label": "Imagen/Flux + script LLM", "badge": "mixed", "default": True},
    ],
    "captions": [
        {"id": "faster-whisper", "label": "faster-whisper local", "badge": "Local", "default": True},
    ],
    "posting": [
        {"id": "youtube-api", "label": "YouTube Data API", "badge": "Free",    "default": True},
        {"id": "blotato",     "label": "Blotato",           "badge": "Metered"},
        {"id": "ig-graph",    "label": "IG Graph",           "badge": "Free"},
    ],
    "production_engine": [
        {"id": "openmontage",       "label": "OpenMontage — in-the-loop",        "badge": "Local", "default": True},
        {"id": "moneyprinterturbo", "label": "MoneyPrinterTurbo — headless volume", "badge": "Local"},
    ],
}

# Validate at import time: every stage in STAGES must have a definition.
_missing = [s for s in STAGES if s not in _RAW]
if _missing:
    raise RuntimeError(f"registry._RAW is missing stages: {_missing}")

_VALID_BADGES = {"Local", "Free", "Metered", "Quota", "mixed"}

# Build the canonical menu (list[StageMenu]) once.
_MENU: list[StageMenu] = []
for _stage in STAGES:
    _options = []
    _defaults = 0
    for _row in _RAW[_stage]:
        badge = _row["badge"]
        if badge not in _VALID_BADGES:
            raise ValueError(f"Unknown badge {badge!r} in stage {_stage!r}")
        _opt = ProviderOption(
            id=_row["id"],
            label=_row["label"],
            badge=badge,
            default=bool(_row.get("default", False)),
        )
        if _opt.default:
            _defaults += 1
        _options.append(_opt.to_dict())
    if _defaults != 1:
        raise ValueError(
            f"Stage {_stage!r} must have exactly 1 default; found {_defaults}"
        )
    _MENU.append(StageMenu(stage=_stage, options=_options))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def provider_menu(stage: str | None = None) -> list[dict]:
    """Return the full registry as a list of StageMenu dicts.

    If *stage* is given, return only the single-element list for that stage.
    Raises KeyError for an unknown stage.
    """
    if stage is None:
        return [sm.to_dict() for sm in _MENU]
    matches = [sm.to_dict() for sm in _MENU if sm.stage == stage]
    if not matches:
        raise KeyError(f"Unknown stage: {stage!r}")
    return matches


def default_for(stage: str) -> str:
    """Return the id of the default provider for *stage*."""
    [menu_dict] = provider_menu(stage)          # raises KeyError if unknown
    for opt in menu_dict["options"]:
        if opt["default"]:
            return opt["id"]
    raise RuntimeError(f"No default found for stage {stage!r}")  # should never happen
