"""RAM-tier degradation logic (Phase 7).

Given a hardware tier (heavy/mid/light) and a job descriptor, produces a
*degradation plan* — a dict of provider and runtime settings that keep the
job alive without OOM-crashing.  Also exposes two pure helpers:

* ``headroom_ok(free_ram_gb, est_ram_gb, guard_gb)`` — headroom safety check.
* ``degrade_or_offload(tier, job, free_ram_gb)`` — three-way routing decision.

Stdlib-only, no pip deps.
"""
from __future__ import annotations

# ── Plan modes ────────────────────────────────────────────────────────────────

_DEFAULTS: dict = {
    "concurrency": 1,
    "unload_between_stages": False,
    "lowvram": False,
    "tiled": False,
    "quant": None,
    "segmented": False,
    "offload": False,
    "note": "",
}


def plan_modes(tier: str, job: dict) -> dict:
    """Return a degradation plan for *tier* + *job*.

    Parameters
    ----------
    tier:
        "heavy" | "mid" | "light"  (from ``probe.tier_for()`` /
        ``probe.machine_info()["tier"]``).
    job:
        ``{stage: str, est_vram_gb: float, est_ram_gb: float, ...}``

    Returns
    -------
    dict with keys:
        concurrency, unload_between_stages, lowvram, tiled, quant,
        segmented, offload, note
    """
    tier = tier.lower()
    plan = dict(_DEFAULTS)

    if tier == "heavy":
        plan.update(
            concurrency=4,
            unload_between_stages=False,
            lowvram=False,
            tiled=False,
            quant="Q8_0",
            segmented=False,
            offload=False,
            note="Full local stack — no restrictions.",
        )

    elif tier == "mid":
        plan.update(
            concurrency=1,
            unload_between_stages=True,
            lowvram=False,
            tiled=True,
            quant="Q4_K_M",
            segmented=False,
            offload=False,
            note="Sequential stages; models unloaded after each stage.",
        )

    else:  # light (≤16/8 GB or no GPU)
        est_vram = float(job.get("est_vram_gb", 0))
        # Heavy-VRAM stages (e.g. video generation) are offloaded.
        needs_offload = est_vram > 4
        plan.update(
            concurrency=1,
            unload_between_stages=True,
            lowvram=True,
            tiled=True,
            quant="Q3_K_S",
            segmented=True,
            offload=needs_offload,
            note=(
                "Minimal local footprint; lowvram + tiled VAE + 3-bit quant + segmented render. "
                + ("Heavy VRAM stage → offload to cloud/pod." if needs_offload else "")
            ).strip(),
        )

    return plan


# ── Headroom helpers ──────────────────────────────────────────────────────────

def headroom_ok(free_ram_gb: float, est_ram_gb: float, guard_gb: float = 2.0) -> bool:
    """True when *free_ram_gb* exceeds *est_ram_gb* + *guard_gb*.

    The guard reserves headroom for the OS and background processes.
    Default ``guard_gb=2`` reserves 2 GiB (PLAN.md §6.2 says 3–4 GB; we use
    2 as the *minimum* check — the caller may pass a larger value).
    """
    return free_ram_gb >= (est_ram_gb + guard_gb)


def degrade_or_offload(tier: str, job: dict, free_ram_gb: float) -> str:
    """Three-way routing decision for a pending job stage.

    Returns
    -------
    "run"       — fits in local RAM; proceed as-is.
    "downgrade" — doesn't fit, but a cheaper local option might (caller
                  should retry with a lower-res / smaller-quant plan).
    "offload"   — Light tier and/or not enough RAM even after downgrade;
                  route to free cloud endpoint or pod.

    Rules
    -----
    * Light tier + insufficient headroom → "offload"
    * Any tier with insufficient headroom → "downgrade"
    * Sufficient headroom → "run"
    """
    est_ram = float(job.get("est_ram_gb", 0))

    if headroom_ok(free_ram_gb, est_ram):
        return "run"

    if tier.lower() == "light":
        return "offload"

    return "downgrade"
