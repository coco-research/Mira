"""Typed shapes for the mira command layer (mirrors plan/SCHEMA.md).

Stdlib-only (dataclasses) to stay wheel-free on Python 3.14. Each model offers
``from_dict`` (filters unknown keys, fills defaults) and ``to_dict`` so contract
tests can round-trip the golden fixtures in SCHEMA.md.
"""
from __future__ import annotations

from dataclasses import dataclass, field, fields, asdict
from typing import Any


# ── Enums / allowed values (kept as tuples for cheap membership tests) ──────────
VIDEO_TYPES = ("short", "long")
ASPECTS = ("9:16", "16:9")
LANES = ("faceless", "cinematic", "personal", "motion", "dub")
TRUST = ("review_all", "auto_publish")
VIDEO_STATES = (
    "idea", "queued", "generating", "draft",
    "in_review", "approved", "scheduled", "posted", "failed",
)
TOPIC_SOURCES = ("manual", "trend", "analytics", "ref_url")
ENGINES = ("openmontage", "moneyprinterturbo")

# Pipeline stages the engine runs (drives registry + cost + checkpoints).
STAGES = (
    "script", "voice_en", "voice_hi", "images", "ai_video",
    "motion", "music", "thumbnail_metadata", "captions",
    "posting", "production_engine",
)

# LLM provider ids — curated from cheahjs/free-llm-api-resources (accessed 2026-06-19).
LLM_PROVIDERS = (
    "lmstudio", "nim", "openrouter", "mistral", "groq", "cerebras",
    "cloudflare", "github-models", "huggingface", "gemini", "uncensored-local",
)
QUOTA_WINDOWS = ("rpm", "rpd", "tpm", "tpd")


def _filter(cls, d: dict[str, Any]) -> dict[str, Any]:
    """Keep only keys that are declared fields of the dataclass ``cls``."""
    known = {f.name for f in fields(cls)}
    return {k: v for k, v in (d or {}).items() if k in known}


# ── Core entities ───────────────────────────────────────────────────────────
@dataclass
class LengthBand:
    min_s: int = 30
    max_s: int = 60
    hard_cap_s: int = 75

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class Channel:
    id: str
    name: str
    language: str = "en"
    video_type: str = "short"
    aspect: str = "9:16"
    faceless: bool = True
    lane: str = "faceless"
    trust: str = "review_all"
    length_band: dict = field(default_factory=lambda: LengthBand().to_dict())
    brand_kit_id: str | None = None
    owner_user_id: str | None = None
    platforms: list = field(default_factory=lambda: ["youtube", "instagram"])
    default_music_id: str | None = None
    created_at: str | None = None

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)

    def validate(self) -> list[str]:
        errs = []
        if self.video_type not in VIDEO_TYPES: errs.append(f"video_type={self.video_type!r}")
        if self.aspect not in ASPECTS: errs.append(f"aspect={self.aspect!r}")
        if self.lane not in LANES: errs.append(f"lane={self.lane!r}")
        if self.trust not in TRUST: errs.append(f"trust={self.trust!r}")
        return errs


@dataclass
class BrandKit:
    id: str
    palette: dict = field(default_factory=dict)
    caption: dict = field(default_factory=dict)
    title_card_font: str = "Newsreader"
    intro_asset: str | None = None
    outro_asset: str | None = None
    watermark: dict = field(default_factory=dict)
    voice: dict = field(default_factory=dict)
    music_duck_db: int = -18

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class Topic:
    id: str
    channel_id: str
    title: str
    source: str = "manual"
    status: str = "queued"
    lane_override: str | None = None
    length_override_s: int | None = None
    scheduled_for: str | None = None
    created_at: str | None = None

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class Video:
    id: str
    topic_id: str | None = None
    channel_id: str | None = None
    engine: str = "openmontage"
    pipeline: str | None = None
    state: str = "draft"
    duration_s: float | None = None
    aspect: str = "9:16"
    artifacts: dict = field(default_factory=dict)
    checkpoints: list = field(default_factory=list)
    cost: dict = field(default_factory=dict)
    ai_disclosure: bool = True
    qa: dict = field(default_factory=dict)
    created_at: str | None = None

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)

    def validate(self) -> list[str]:
        errs = []
        if self.state not in VIDEO_STATES: errs.append(f"state={self.state!r}")
        if self.engine not in ENGINES: errs.append(f"engine={self.engine!r}")
        return errs


@dataclass
class Package:
    video_id: str
    variants: list = field(default_factory=list)
    description: str = ""
    tags: list = field(default_factory=list)
    hashtags: list = field(default_factory=list)
    language: str = "en"

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


# ── State / probe / swarm ─────────────────────────────────────────────────────
@dataclass
class CostLogEntry:
    video_id: str
    stage: str
    provider: str
    units: float = 1
    cost: float = 0.0
    note: str | None = None
    ts: str | None = None

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class MachineInfo:
    os: str
    ram_gb: int
    vram_gb: int = 0
    gpu: str = "unknown"
    tier: str = "light"        # heavy | mid | light

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class SupportEnvelope:
    machine: dict
    engines: dict
    providers: dict

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class ProviderOption:
    id: str
    label: str
    badge: str               # Local | Free | Metered | Quota | mixed
    default: bool = False

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class StageMenu:
    stage: str
    options: list           # list[ProviderOption-as-dict]

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)


@dataclass
class QuotaLedgerRow:
    pod_id: str
    user_id: str
    provider: str
    window: str = "rpd"
    used: int = 0
    limit: int = 0
    window_start: str | None = None
    healthy: bool = True
    last_429_at: str | None = None

    @classmethod
    def from_dict(cls, d): return cls(**_filter(cls, d))
    def to_dict(self): return asdict(self)
