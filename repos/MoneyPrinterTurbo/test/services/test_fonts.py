import os
import tempfile
import unittest
from unittest.mock import patch

from app.models import const
from app.utils import utils


class TestResolveFontPath(unittest.TestCase):
    """Subtitle fonts are looked up at runtime; Mira ships no CJK font file."""

    def test_no_proprietary_font_is_bundled(self):
        bundled = os.listdir(utils.font_dir())
        for name in const.REMOVED_FONT_ALIASES:
            self.assertNotIn(name, bundled)
        for name in bundled:
            for banned in ("YaHei", "Heiti", "Kabel"):
                self.assertNotIn(banned, name)

    def test_bundled_file_wins(self):
        path = utils.resolve_font_path("Charm-Regular.ttf")
        self.assertEqual(path, os.path.join(utils.font_dir(), "Charm-Regular.ttf"))

    def test_removed_font_names_map_to_noto(self):
        seen = []
        with patch.object(utils, "_fc_match", side_effect=lambda p: seen.append(p) or "/x.ttc"):
            for old, alias in const.REMOVED_FONT_ALIASES.items():
                self.assertEqual(utils.resolve_font_path(old), "/x.ttc")
                self.assertEqual(seen[-1], alias)
                self.assertTrue(alias.startswith("Noto Sans CJK"))

    def test_empty_name_uses_default(self):
        seen = []
        with patch.object(utils, "_fc_match", side_effect=lambda p: seen.append(p) or "/y.ttc"):
            self.assertEqual(utils.resolve_font_path(""), "/y.ttc")
        self.assertEqual(seen, [const.DEFAULT_FONT_NAME])

    def test_falls_back_to_system_candidate_then_bundled_ofl(self):
        with tempfile.NamedTemporaryFile(suffix=".ttc") as f:
            with patch.object(utils, "_fc_match", return_value=""), \
                    patch.object(utils, "_SYSTEM_CJK_FONT_CANDIDATES", [f.name]):
                self.assertEqual(utils.resolve_font_path(const.DEFAULT_FONT_NAME), f.name)
        with patch.object(utils, "_fc_match", return_value=""), \
                patch.object(utils, "_SYSTEM_CJK_FONT_CANDIDATES", []):
            self.assertEqual(
                utils.resolve_font_path(const.DEFAULT_FONT_NAME),
                os.path.join(utils.font_dir(), "Charm-Regular.ttf"),
            )


if __name__ == "__main__":
    unittest.main()
