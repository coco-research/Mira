"""Contract tests for mira.registry — stdlib + pytest only."""
import pytest
from mira import schemas
from mira.registry import default_for, provider_menu

VALID_BADGES = {"Local", "Free", "Metered", "Quota", "mixed"}


class TestProviderMenu:
    def test_all_stages_present(self):
        menus = provider_menu()
        returned_stages = {m["stage"] for m in menus}
        assert returned_stages == set(schemas.STAGES)

    def test_exactly_one_default_per_stage(self):
        for menu in provider_menu():
            defaults = [o for o in menu["options"] if o["default"]]
            assert len(defaults) == 1, (
                f"Stage {menu['stage']!r} has {len(defaults)} defaults, expected 1"
            )

    def test_all_badges_valid(self):
        for menu in provider_menu():
            for opt in menu["options"]:
                assert opt["badge"] in VALID_BADGES, (
                    f"Stage {menu['stage']!r} option {opt['id']!r} "
                    f"has invalid badge {opt['badge']!r}"
                )

    def test_stage_filter(self):
        result = provider_menu("script")
        assert len(result) == 1
        assert result[0]["stage"] == "script"

    def test_unknown_stage_raises(self):
        with pytest.raises(KeyError):
            provider_menu("nonexistent_stage")


class TestScriptStageProviders:
    """The five new free providers added in this sprint must be present."""

    def _script_ids(self):
        [menu] = provider_menu("script")
        return {o["id"] for o in menu["options"]}

    def test_mistral_present(self):
        assert "mistral" in self._script_ids()

    def test_groq_present(self):
        assert "groq" in self._script_ids()

    def test_cerebras_present(self):
        assert "cerebras" in self._script_ids()

    def test_cloudflare_present(self):
        assert "cloudflare" in self._script_ids()

    def test_github_models_present(self):
        assert "github-models" in self._script_ids()


class TestDefaultFor:
    def test_script_default_is_lmstudio(self):
        assert default_for("script") == "lmstudio"

    def test_voice_en_default_is_edge_tts(self):
        assert default_for("voice_en") == "edge-tts"

    def test_unknown_stage_raises(self):
        with pytest.raises(KeyError):
            default_for("does_not_exist")
