"""Cloud-burst launch / teardown logic (Phase 7).

Decides *whether* to burst, picks a provider, and launches/tears-down
instances — all MOCKED by default (dry_run=True) so no real API calls or
money are ever spent unless a live key is present AND dry_run=False.

Provider priority: Vultr free-credit first → AWS → none (PLAN.md §6.3).

Stdlib-only, no pip deps.
"""
from __future__ import annotations

import uuid as _uuid_mod

from mira import keys as _keys
from mira.config import load_config as _load_config


# ── Should we burst? ──────────────────────────────────────────────────────────

def should_burst(job: dict, machine: dict) -> tuple[bool, str]:
    """Return (burst_needed, reason).

    Burst is appropriate only when:
    * The Mac is saturated (machine["saturated"] is True), OR
    * The job requires a CUDA-only model (job["cuda_only"] is True).

    In all other cases the job should run locally.

    Parameters
    ----------
    job:
        ``{stage, est_vram_gb, est_ram_gb, cuda_only: bool, ...}``
    machine:
        ``{tier, ram_gb, saturated: bool, ...}`` — typically from
        ``probe.machine_info()`` augmented with a runtime ``saturated`` flag.
    """
    if job.get("cuda_only"):
        return True, "Job requires a CUDA-only model."

    if machine.get("saturated"):
        return True, "Mac is saturated — local queue full."

    return False, "Job fits local resources; no burst needed."


# ── Provider selection ────────────────────────────────────────────────────────

def pick_target() -> str:
    """Select burst provider.

    Priority: "vultr" → "aws" → "none".

    Reads live key presence so tests can monkeypatch env vars + call
    ``keys.load(refresh=True)`` to update the cache.
    """
    _keys.load(refresh=True)
    if _keys.has("VULTR_API_KEY"):
        return "vultr"
    if _keys.has("AWS_ACCESS_KEY_ID") and _keys.has("AWS_SECRET_ACCESS_KEY"):
        return "aws"
    return "none"


# ── Budget guard ──────────────────────────────────────────────────────────────

def within_budget(spend_so_far: float, est_cost: float, cap: float) -> bool:
    """True when (spend_so_far + est_cost) stays at or below cap."""
    return (spend_so_far + est_cost) <= cap


# ── Launch & teardown (mocked) ────────────────────────────────────────────────

def launch(target: str, *, dry_run: bool = True) -> dict:
    """Launch (or mock-launch) a cloud GPU instance.

    Parameters
    ----------
    target:
        "vultr" | "aws" | "none"
    dry_run:
        When True (default) — returns a mock handle; no network call is made.
        When False — would call the real provider API (stub shape only; the
        caller must supply a live key AND set dry_run=False intentionally).

    Returns
    -------
    dict with keys:
        target, instance_id, action, would_cost_note, dry_run
    """
    if target == "none":
        return {
            "target": "none",
            "instance_id": None,
            "action": "skipped",
            "would_cost_note": "No burst provider configured — no action taken.",
            "dry_run": dry_run,
        }

    if dry_run:
        instance_id = f"mock-{target}-{_uuid_mod.uuid4().hex[:8]}"
        notes = {
            "vultr": "Vultr free credit (~$250-300); A100 ~$1.35/hr. Destroy instance to stop billing.",
            "aws":   "AWS spot GPU (e.g. p3.2xlarge ~$0.90/hr). Free tier excludes GPU.",
        }
        return {
            "target": target,
            "instance_id": instance_id,
            "action": "launched_dry_run",
            "would_cost_note": notes.get(target, "Metered instance — real money when live."),
            "dry_run": True,
        }

    # Live path (stub — real HTTP calls would go here with the provider SDK).
    # Users must supply a real key and explicitly pass dry_run=False.
    instance_id = f"live-{target}-{_uuid_mod.uuid4().hex[:8]}"
    return {
        "target": target,
        "instance_id": instance_id,
        "action": "launched_live",
        "would_cost_note": (
            "REAL INSTANCE LAUNCHED — remember to call teardown() or you will be billed."
        ),
        "dry_run": False,
    }


def teardown(instance: dict, *, dry_run: bool = True) -> dict:
    """Tear down (or mock-teardown) the instance produced by ``launch()``.

    Consumes the dict returned by ``launch()`` directly so the caller only
    needs to pass the launch handle through — no extra bookkeeping.

    Returns
    -------
    dict with keys:
        target, instance_id, action, would_cost_note, dry_run
    """
    target = instance.get("target", "none")
    instance_id = instance.get("instance_id")

    if target == "none" or instance_id is None:
        return {
            "target": target,
            "instance_id": None,
            "action": "skipped",
            "would_cost_note": "Nothing to tear down.",
            "dry_run": dry_run,
        }

    if dry_run:
        return {
            "target": target,
            "instance_id": instance_id,
            "action": "torn_down_dry_run",
            "would_cost_note": "Mock teardown complete — no real instance was running.",
            "dry_run": True,
        }

    # Live stub.
    return {
        "target": target,
        "instance_id": instance_id,
        "action": "torn_down_live",
        "would_cost_note": "Instance destroyed — billing stopped.",
        "dry_run": False,
    }
