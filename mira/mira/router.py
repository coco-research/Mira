"""Quota-aware swarm router for the Mira command layer.

Implements the §6.3 policy chain:
    free_local → own_free_cloud → pod_swarm → metered → burst

Pure logic module — in-memory ledger is a plain list[dict] whose rows are
shaped like ``QuotaLedgerRow`` (see schemas.py).  No external deps; stdlib only.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence

# ── Policy chain ─────────────────────────────────────────────────────────────
POLICY_CHAIN: list[str] = [
    "free_local",       # on-device, zero cost (LM Studio, ComfyUI)
    "own_free_cloud",   # requester's own perpetual-free API accounts
    "pod_swarm",        # a pod member with spare quota dispatches on their key
    "metered",          # paid-per-use providers (Kling, Sarvam, Seedance, Suno)
    "burst",            # cloud-GPU burst (Vultr free credit → AWS)
]

# ── Provider → chain stage classification ────────────────────────────────────
# Keys are provider_id strings used throughout the mira layer.
# pod_swarm is deliberately absent: pod membership is determined at runtime by
# the ledger's pod_id field (any provider owned by another pod member) rather
# than a static string.  Providers present in multiple contexts (e.g. a pod
# member also running NIM) are classified by the requester's own account here;
# the swarm dispatcher handles cross-member dispatch separately.
TIER: dict[str, str] = {
    # free_local — runs entirely on the user's own hardware, zero API calls
    "lmstudio":         "free_local",
    "comfyui":          "free_local",
    "uncensored-local": "free_local",   # abliterated GGUF in LM Studio / ComfyUI

    # own_free_cloud — perpetual free-tier OpenAI-compatible endpoints
    "nim":              "own_free_cloud",   # NVIDIA NIM (~40 req/min free tier)
    "openrouter":       "own_free_cloud",   # OpenRouter free models
    "mistral":          "own_free_cloud",   # Mistral La Plateforme ~1B tok/mo free
    "groq":             "own_free_cloud",   # Groq ~14.4k req/day free
    "cerebras":         "own_free_cloud",   # Cerebras ~14.4k req/day free
    "cloudflare":       "own_free_cloud",   # Cloudflare Workers AI 10k neurons/day
    "github-models":    "own_free_cloud",   # GitHub Models (Copilot tier)
    "gemini":           "own_free_cloud",   # Gemini free tier + Vertex Veo quota
    "huggingface":      "own_free_cloud",   # HuggingFace Inference API free tier

    # metered — pay-per-use creative/media APIs
    "kling":            "metered",   # Kling motion transfer (MuAPI credits)
    "sarvam":           "metered",   # Sarvam Bulbul Hindi TTS (~$0.02-0.05/video)
    "seedance":         "metered",   # Seedance 2.0 Mini cheap AI video drafts
    "suno":             "metered",   # Suno custom music beds

    # burst — cloud-GPU on-demand (spin up only when Mac is saturated/insufficient)
    "vultr":            "burst",     # Vultr free credit A100/A40 ($250-300 new acct)
    "aws":              "burst",     # AWS spot GPU (fallback after Vultr credit gone)
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _match(row: dict, user_id: str, provider: str) -> bool:
    return row.get("user_id") == user_id and row.get("provider") == provider


def is_available(row: dict) -> bool:
    """Return True when the row is healthy AND has not exhausted its quota.

    A ``limit`` of 0 (or negative) means *unlimited* — always considered in-budget.
    """
    if not row.get("healthy", True):
        return False
    limit = row.get("limit", 0)
    if limit > 0 and row.get("used", 0) >= limit:
        return False
    return True


def record_use(
    ledger: list[dict],
    user_id: str,
    provider: str,
    n: int = 1,
    window: str = "rpd",
) -> None:
    """Increment the ``used`` counter for ``(user_id, provider)``.

    Creates a bare row if one does not yet exist (healthy=True, limit=0).
    """
    for row in ledger:
        if _match(row, user_id, provider):
            row["used"] = row.get("used", 0) + n
            return
    # No existing row — create one
    ledger.append({
        "pod_id": "",
        "user_id": user_id,
        "provider": provider,
        "window": window,
        "used": n,
        "limit": 0,
        "window_start": _now_iso(),
        "healthy": True,
        "last_429_at": None,
    })


def mark_429(ledger: list[dict], user_id: str, provider: str) -> None:
    """Mark a provider as rate-limited (healthy=False) and record the timestamp.

    Creates a bare row if missing (so backoff is recorded even without prior use).
    """
    for row in ledger:
        if _match(row, user_id, provider):
            row["healthy"] = False
            row["last_429_at"] = _now_iso()
            return
    ledger.append({
        "pod_id": "",
        "user_id": user_id,
        "provider": provider,
        "window": "rpd",
        "used": 0,
        "limit": 0,
        "window_start": None,
        "healthy": False,
        "last_429_at": _now_iso(),
    })


def reset_window(ledger: list[dict], provider: str | None = None) -> None:
    """Reset quota counters at the start of a new window.

    If ``provider`` is given, only rows for that provider are reset.
    Clears ``used`` to 0 and restores ``healthy`` to True.
    """
    for row in ledger:
        if provider is None or row.get("provider") == provider:
            row["used"] = 0
            row["healthy"] = True


def choose_provider(
    stage_candidates: list[str],
    ledger: list[dict],
    *,
    user_id: str | None = None,
    pinned_local: bool = False,
    local_ids: Sequence[str] = ("lmstudio", "comfyui"),
) -> str | None:
    """Pick the best available provider from *stage_candidates*.

    Selection logic
    ---------------
    1. If ``pinned_local`` is True, restrict candidates to those whose
       provider id is in ``local_ids``; return None if none are available.
    2. Otherwise, walk ``POLICY_CHAIN`` in order.  For each stage, collect
       the subset of ``stage_candidates`` that maps to that stage and is
       available (healthy + within quota) according to the ledger.
    3. Within the first non-empty stage, pick the candidate with the
       *lowest* ``used`` count (least-used-first rotation).
    4. A provider not present in the ledger is treated as used=0 and
       healthy=True (never-seen ≡ fully fresh).
    5. Returns None when no candidate is available.

    Parameters
    ----------
    stage_candidates:
        Provider ids eligible for this job (e.g. those that support the
        required model/capability).
    ledger:
        The in-memory quota ledger (list of dicts shaped like QuotaLedgerRow).
    pinned_local:
        When True, only local providers (``local_ids``) are considered.
        Use for personal-footage jobs or "run on my machine only" jobs.
    local_ids:
        Provider ids considered local-only (default: lmstudio, comfyui).
    """
    if pinned_local:
        candidates = [p for p in stage_candidates if p in local_ids]
    else:
        candidates = list(stage_candidates)

    if not candidates:
        return None

    def _best_row(provider: str) -> dict:
        """Return the ledger row for provider, or a synthetic fresh row.

        When ``user_id`` is given (pod-swarm mode), match that user's row so we
        read the correct member's quota instead of the first row for the provider.
        """
        if user_id is not None:
            for row in ledger:
                if _match(row, user_id, provider):
                    return row
        for row in ledger:
            if row.get("provider") == provider:
                return row
        return {"provider": provider, "used": 0, "healthy": True, "limit": 0}

    if pinned_local:
        # Within local candidates pick least-used available
        available = [p for p in candidates if is_available(_best_row(p))]
        if not available:
            return None
        return min(available, key=lambda p: _best_row(p).get("used", 0))

    # Walk policy chain; pick first stage with at least one available candidate
    stage_of: dict[str, str] = {}
    for p in candidates:
        stage_of[p] = TIER.get(p, "burst")  # unknown provider → treat as burst

    for stage in POLICY_CHAIN:
        in_stage = [p for p in candidates if stage_of[p] == stage]
        available = [p for p in in_stage if is_available(_best_row(p))]
        if available:
            return min(available, key=lambda p: _best_row(p).get("used", 0))

    return None
