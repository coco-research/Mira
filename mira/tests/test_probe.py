"""Contract tests for mira.probe — stdlib-only capability probe."""
from __future__ import annotations

import pytest

from mira.probe import (
    engine_status,
    machine_info,
    port_open,
    support_envelope,
    tier_for,
)


# ── support_envelope() shape ──────────────────────────────────────────────────

class TestSupportEnvelopeShape:
    def test_top_level_keys(self):
        env = support_envelope()
        assert set(env) == {"machine", "engines", "providers"}

    def test_machine_keys(self):
        machine = support_envelope()["machine"]
        assert set(machine) >= {"os", "ram_gb", "vram_gb", "gpu", "tier"}

    def test_engines_keys(self):
        engines = support_envelope()["engines"]
        assert set(engines) == {"openmontage", "moneyprinterturbo", "comfyui"}

    def test_engines_are_booleans(self):
        engines = support_envelope()["engines"]
        for key, val in engines.items():
            assert isinstance(val, bool), f"engines[{key!r}] is not bool: {val!r}"

    def test_providers_llm_pool(self):
        llm = support_envelope()["providers"]["llm"]
        required = {"mistral", "groq", "cerebras", "cloudflare", "github-models"}
        assert required.issubset(set(llm)), f"missing providers in llm list: {required - set(llm)}"


# ── tier_for() ───────────────────────────────────────────────────────────────

class TestTierFor:
    @pytest.mark.parametrize("ram_gb,expected", [
        (64, "heavy"),
        (48, "heavy"),
        (32, "mid"),
        (24, "mid"),
        (8,  "light"),
        (0,  "light"),
    ])
    def test_tier_boundaries(self, ram_gb, expected):
        assert tier_for(ram_gb) == expected

    def test_heavy_boundary_explicit(self):
        assert tier_for(64) == "heavy"

    def test_mid_boundary_explicit(self):
        assert tier_for(32) == "mid"

    def test_light_boundary_explicit(self):
        assert tier_for(8) == "light"


# ── machine-specific (darwin) ─────────────────────────────────────────────────

class TestMachineInfo:
    def test_os_is_known(self):
        info = machine_info()
        assert info["os"] in ("darwin", "linux", "windows")

    def test_ram_gb_positive(self):
        info = machine_info()
        assert info["ram_gb"] > 0, "Expected non-zero RAM on this machine"

    def test_machine_info_keys(self):
        info = machine_info()
        assert set(info) >= {"os", "ram_gb", "vram_gb", "gpu", "tier"}

    def test_tier_is_valid(self):
        info = machine_info()
        assert info["tier"] in ("heavy", "mid", "light")

    def test_vram_gb_is_int(self):
        info = machine_info()
        assert isinstance(info["vram_gb"], int)


# ── engine_status() ──────────────────────────────────────────────────────────

class TestEngineStatus:
    def test_openmontage_reflects_repo_presence(self):
        # Portable: assert the probe matches actual on-disk repo presence,
        # not a machine-pinned True (works on CI / other dev boxes).
        from pathlib import Path
        from mira.config import PROJECT_DIR
        engines = engine_status()
        expected = (PROJECT_DIR.parent / "repos" / "OpenMontage").is_dir()
        assert engines["openmontage"] is expected

    def test_engine_status_shape(self):
        engines = engine_status()
        assert set(engines) == {"openmontage", "moneyprinterturbo", "comfyui"}


# ── port_open() ──────────────────────────────────────────────────────────────

class TestPortOpen:
    def test_closed_port_returns_false(self):
        # Port 1 is privileged and almost certainly not listening on any CI/dev machine.
        assert port_open("127.0.0.1", 1) is False

    def test_returns_bool(self):
        result = port_open("127.0.0.1", 1)
        assert isinstance(result, bool)
