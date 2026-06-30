"""Golden fixtures — the single source of fake data for Phase 0.

These mirror plan/SCHEMA.md and dashboard/partials/_CONTRACT.md so the CLI/API,
the dashboard, and the contract tests all agree. Phase 3 swaps these for live
data; until then every `mira` stub returns from here.
"""
from __future__ import annotations

CHANNELS = [
    {
        "id": "chn_aitools", "name": "Mira AI Tools", "language": "en",
        "video_type": "short", "aspect": "9:16", "faceless": True, "lane": "faceless",
        "trust": "review_all", "length_band": {"min_s": 30, "max_s": 60, "hard_cap_s": 75},
        "brand_kit_id": "bk_aitools", "owner_user_id": "usr_rijul",
        "platforms": ["youtube", "instagram"], "default_music_id": "mus_lofi_soft",
        "created_at": "2026-06-18T00:00:00Z",
    },
    {
        "id": "chn_deepdives", "name": "Mira Deep Dives", "language": "en",
        "video_type": "long", "aspect": "16:9", "faceless": True, "lane": "cinematic",
        "trust": "review_all", "length_band": {"min_s": 180, "max_s": 300, "hard_cap_s": 360},
        "brand_kit_id": "bk_deepdives", "owner_user_id": "usr_rijul",
        "platforms": ["youtube"], "default_music_id": "mus_ambient_pad",
        "created_at": "2026-06-18T00:00:00Z",
    },
    {
        "id": "chn_quickwins", "name": "Mira Quick Wins", "language": "en",
        "video_type": "short", "aspect": "9:16", "faceless": True, "lane": "faceless",
        "trust": "auto_publish", "length_band": {"min_s": 30, "max_s": 45, "hard_cap_s": 60},
        "brand_kit_id": "bk_quickwins", "owner_user_id": "usr_rijul",
        "platforms": ["youtube", "instagram"], "default_music_id": "mus_upbeat_pluck",
        "created_at": "2026-06-18T00:00:00Z",
    },
]

BRAND_KITS = [
    {
        "id": "bk_aitools",
        "palette": {"paper": "#faf9f5", "ink": "#141413", "accent": "#cc785c"},
        "caption": {"font": "Inter", "weight": "600", "position": "bottom_third", "highlight": "#cc785c"},
        "title_card_font": "Newsreader",
        "intro_asset": "assets/intro_aitools.mp4", "outro_asset": "assets/outro_aitools.mp4",
        "watermark": {"text": "Mira", "position": "br", "opacity": 0.6},
        "voice": {"provider": "edge-tts", "voice": "en-US-AndrewNeural", "rate": 1.0},
        "music_duck_db": -18,
    },
]

TOPICS = [
    {
        "id": "top_5free", "channel_id": "chn_aitools",
        "title": "5 free AI tools that feel illegal to know", "source": "manual",
        "status": "queued", "lane_override": None, "length_override_s": None,
        "scheduled_for": "2026-06-22T14:00:00Z", "created_at": "2026-06-18T00:00:00Z",
    },
]

# 7 sample videos + 1 failure fixture (matches _CONTRACT).
VIDEOS = [
    {"id": "vid_a1b2", "topic_id": "top_5free", "channel_id": "chn_aitools",
     "engine": "openmontage", "pipeline": "animated-explainer", "state": "in_review",
     "duration_s": 47.0, "aspect": "9:16", "ai_disclosure": True,
     "cost": {"estimate": 0.0, "actual": 0.0, "currency": "USD"},
     "qa": {"passed": True, "duration_in_band": True, "variation_ok": True}},
    {"id": "vid_c3d4", "channel_id": "chn_aitools", "engine": "openmontage",
     "pipeline": "motion-transfer", "state": "in_review", "duration_s": 52.0, "aspect": "9:16",
     "cost": {"estimate": 0.18, "actual": 0.18, "currency": "USD"}},
    {"id": "vid_e5f6", "channel_id": "chn_quickwins", "engine": "moneyprinterturbo",
     "pipeline": "headless-short", "state": "in_review", "duration_s": 38.0, "aspect": "9:16"},
    {"id": "vid_g7h8", "channel_id": "chn_aitools", "engine": "openmontage",
     "pipeline": "animated-explainer", "state": "scheduled", "duration_s": 41.0, "aspect": "9:16"},
    {"id": "vid_i9j0", "channel_id": "chn_deepdives", "engine": "openmontage",
     "pipeline": "documentary-longform", "state": "draft", "duration_s": 252.0, "aspect": "16:9"},
    {"id": "vid_k1l2", "channel_id": "chn_aitools", "engine": "openmontage",
     "pipeline": "animated-explainer", "state": "posted", "duration_s": 44.0, "aspect": "9:16"},
    {"id": "vid_m3n4", "channel_id": "chn_quickwins", "engine": "moneyprinterturbo",
     "pipeline": "headless-short", "state": "posted", "duration_s": 36.0, "aspect": "9:16"},
    {"id": "vid_p5q6", "channel_id": "chn_aitools", "engine": "openmontage",
     "pipeline": "animated-explainer", "state": "failed", "duration_s": None, "aspect": "9:16",
     "qa": {"failed_stage": "ai_video", "reason": "ComfyUI OOM — auto-downgraded, retry available"}},
]

IDEAS = [
    {"title": "Nano-Banana image API — first look", "source": "trend"},
    {"title": "Veo 3.1 vs local LTX — honest test", "source": "manual"},
    {"title": "The $0 faceless stack, end to end", "source": "manual"},
    {"title": "5 prompts that 10x your output", "source": "trend"},
    {"title": "Local AI on a 16GB laptop?", "source": "ref_url"},
    {"title": "Best free TTS in 2026", "source": "trend"},
    {"title": "Motion-transfer explained simply", "source": "analytics"},
]

# Header cost meter (MTD).
COST_METER = {
    "spend_mtd": 11.40, "cap": 50.0, "currency": "USD",
    "breakdown": {"veo_quota": 0.0, "kling_muapi": 7.20, "sarvam": 1.10, "suno": 0.30},
    "vultr_credit_used": 2.80, "vultr_credit_total": 250.0,
    "forecast_days_to_cap": 19,
}

# Today stat tiles.
TODAY = {"to_review": 3, "scheduled_today": 2, "spend": "11.40/50", "ideas_waiting": 7, "alerts": 1}

# support_envelope() golden shape (the probe returns a live version of this).
SUPPORT_ENVELOPE = {
    "machine": {"os": "darwin", "ram_gb": 64, "vram_gb": 0, "gpu": "apple_m4_max", "tier": "heavy"},
    "engines": {"openmontage": True, "moneyprinterturbo": True, "comfyui": True},
    "providers": {
        "llm": ["lmstudio", "nim", "openrouter", "mistral", "groq", "cerebras",
                "cloudflare", "github-models", "huggingface", "gemini", "uncensored-local"],
        "tts": ["edge-tts", "google-tts", "sarvam"],
        "image": ["sdxl-local", "imagen", "nim-flux", "uncensored-local"],
        "video": ["veo-quota", "comfy-ltx", "seedance", "skyreels-burst"],
        "music": ["pixabay", "freesound", "music_gen", "suno"],
    },
}

# cost_model.json seed (estimator memory).
COST_MODEL = {
    "updated_at": "2026-06-18T00:00:00Z", "alpha": 0.3,
    "units": {
        "veo_clip_s": {"ema_cost": 0.0, "ema_eta_s": 14, "n": 22, "source": "vertex_quota"},
        "kling_motion_s": {"ema_cost": 0.09, "ema_eta_s": 40, "n": 5},
        "comfy_ltx_clip": {"ema_cost": 0.0, "ema_eta_s": 95, "n": 18, "source": "local_gpu_time"},
        "skyreels_14b_burst_min": {"ema_cost": 0.42, "ema_eta_s": 60, "n": 3, "source": "vultr"},
        "suno_track": {"ema_cost": 0.10, "ema_eta_s": 30, "n": 2},
    },
}


def channel(cid: str):
    return next((c for c in CHANNELS if c["id"] == cid), None)


def video(vid: str):
    return next((v for v in VIDEOS if v["id"] == vid), None)
