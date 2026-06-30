"""Live capability probe — returns the support_envelope() shape from SCHEMA.md.

Stdlib-only (no pip installs). Detects hardware, running engines, and provider
availability so the rest of the command layer can gate features at runtime.
"""
from __future__ import annotations

import os
import platform
import re
import socket
import subprocess
from pathlib import Path

from mira import fixtures
from mira.config import PROJECT_DIR

# Repos root is one level above the project dir (i.e. ../repos/ relative to the
# mira/ project directory which lives inside the monorepo).
_REPOS_DIR = PROJECT_DIR.parent / "repos"


# ── Hardware detection ────────────────────────────────────────────────────────

def _ram_gb_macos() -> int:
    """Read physical RAM on macOS via sysctl."""
    try:
        out = subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"], stderr=subprocess.DEVNULL, text=True
        )
        return int(out.strip()) // (2 ** 30)
    except Exception:
        return 0


def _ram_gb_linux() -> int:
    """Read physical RAM on Linux via os.sysconf."""
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
        return (page_size * page_count) // (2 ** 30)
    except Exception:
        return 0


def _gpu_name_macos() -> str:
    """Derive Apple Silicon GPU name from cpu brand string.

    Returns a slug like ``apple_m4_max``.  Falls back to ``unknown`` when the
    brand string cannot be parsed or is not Apple Silicon.
    """
    # Try sysctl first (more reliable on macOS)
    brand = ""
    try:
        brand = subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        brand = platform.processor()

    if not brand:
        return "unknown"

    lower = brand.lower()
    # Match "Apple M4 Max" → "apple_m4_max"
    match = re.search(r"(apple\s+m\d+(?:\s+(?:max|pro|ultra|base))?)", lower)
    if match:
        return re.sub(r"\s+", "_", match.group(1).strip())

    # Broader fallback: any "Apple ..." CPU
    if lower.startswith("apple"):
        return re.sub(r"\s+", "_", lower.split("(")[0].strip())

    return "unknown"


def machine_info() -> dict:
    """Return live hardware details for this machine.

    Keys
    ----
    os       : platform.system().lower() — e.g. "darwin"
    ram_gb   : int, physical RAM in GiB (0 if detection fails)
    vram_gb  : int, dedicated VRAM in GiB (0 if unknown / unified memory)
    gpu      : str, GPU/chip identifier slug
    tier     : "heavy" | "mid" | "light"
    """
    sys = platform.system().lower()

    if sys == "darwin":
        ram_gb = _ram_gb_macos()
        gpu = _gpu_name_macos()
        # Apple Silicon uses unified memory; VRAM is not separately exposed.
        vram_gb = 0
    elif sys == "linux":
        ram_gb = _ram_gb_linux()
        gpu = "unknown"
        vram_gb = 0
    else:
        ram_gb = 0
        gpu = "unknown"
        vram_gb = 0

    has_gpu = gpu != "unknown"
    tier = tier_for(ram_gb, has_gpu)

    return {
        "os": sys,
        "ram_gb": ram_gb,
        "vram_gb": vram_gb,
        "gpu": gpu,
        "tier": tier,
    }


# ── Tier classification ───────────────────────────────────────────────────────

def tier_for(ram_gb: int, has_gpu: bool = False) -> str:
    """Classify machine tier from available RAM.

    Rules
    -----
    * ram_gb >= 48  → "heavy"  (can run large local models + video pipelines)
    * ram_gb >= 24  → "mid"    (can run mid-size local models)
    * otherwise     → "light"  (cloud-only or minimal local use)

    ``has_gpu`` is accepted for forward-compatibility but is not currently used
    in the tier formula — Apple Silicon unified-memory machines have gpu="apple_…"
    and already express capacity through RAM.
    """
    if ram_gb >= 48:
        return "heavy"
    if ram_gb >= 24:
        return "mid"
    return "light"


# ── Network helpers ───────────────────────────────────────────────────────────

def port_open(host: str, port: int, timeout: float = 0.2) -> bool:
    """Return True if a TCP connection to host:port succeeds within *timeout* s."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


# ── Engine detection ──────────────────────────────────────────────────────────

def engine_status() -> dict:
    """Return a dict of booleans for each supported local engine.

    * openmontage     — repo directory exists under ``<repos>/OpenMontage``
    * moneyprinterturbo — repo directory exists under ``<repos>/MoneyPrinterTurbo``
    * comfyui         — TCP port 8188 is accepting connections on localhost
    """
    return {
        "openmontage": (_REPOS_DIR / "OpenMontage").is_dir(),
        "moneyprinterturbo": (_REPOS_DIR / "MoneyPrinterTurbo").is_dir(),
        "comfyui": port_open("127.0.0.1", 8188),
    }


# ── Capability envelope ───────────────────────────────────────────────────────

def support_envelope() -> dict:
    """Assemble the full capability envelope for this machine.

    Shape mirrors ``plan/SCHEMA.md § support_envelope()`` and the golden fixture
    in ``fixtures.SUPPORT_ENVELOPE``.  The ``providers`` section is sourced
    directly from that fixture so the LLM pool stays in sync with a single edit.
    """
    return {
        "machine": machine_info(),
        "engines": engine_status(),
        "providers": fixtures.SUPPORT_ENVELOPE["providers"],
    }
