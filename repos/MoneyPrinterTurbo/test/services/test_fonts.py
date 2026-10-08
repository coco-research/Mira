import os
import shutil
import stat
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import ImageFont

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


def _build_collection(paths, out):
    """Pack single-face sfnt files into a .ttc (test helper, no fontTools)."""
    blobs = [open(p, "rb").read() for p in paths]
    header_len = 12 + 4 * len(blobs)
    offsets, body = [], bytearray()
    for blob in blobs:
        (num_tables,) = struct.unpack(">H", blob[4:6])
        dir_len = 12 + 16 * num_tables
        base = header_len + len(body)
        offsets.append(base)
        tables = bytearray()
        records = bytearray()
        data_start = base + dir_len
        for i in range(num_tables):
            tag, checksum, t_off, t_len = struct.unpack(">4sIII", blob[12 + 16 * i : 28 + 16 * i])
            chunk = blob[t_off : t_off + t_len]
            records += struct.pack(">4sIII", tag, checksum, data_start + len(tables), t_len)
            tables += chunk + b"\0" * (-len(chunk) % 4)
        body += blob[:12] + records + tables
    with open(out, "wb") as f:
        f.write(b"ttcf" + struct.pack(">HHI", 1, 0, len(blobs)))
        f.write(struct.pack(f">{len(blobs)}I", *offsets))
        f.write(body)


@unittest.skipIf(sys.platform == "win32", "fake fc-match is a POSIX shell script")
class TestFcMatch(unittest.TestCase):
    """_fc_match against a fake fc-match binary on PATH (M1, M2)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.argv_log = os.path.join(self.tmp, "argv")
        self.font = os.path.join(self.tmp, "Real Font.ttf")
        shutil.copy(os.path.join(utils.font_dir(), "Charm-Regular.ttf"), self.font)
        self.addCleanup(shutil.rmtree, self.tmp)

    def fake(self, stdout, rc=0):
        script = os.path.join(self.tmp, "fc-match")
        with open(script, "w") as f:
            f.write("#!/bin/sh\n")
            f.write(f'for a in "$@"; do printf "%s\\n" "$a"; done > "{self.argv_log}"\n')
            f.write(f"printf '%s' '{stdout}'\nexit {rc}\n")
        os.chmod(script, os.stat(script).st_mode | stat.S_IEXEC)
        return patch.dict(os.environ, {"PATH": self.tmp + os.pathsep + os.environ.get("PATH", "")})

    def argv(self):
        with open(self.argv_log) as f:
            return f.read().splitlines()

    def test_accepts_requested_family_and_passes_double_dash(self):
        with self.fake(f"Real Font,Real Font Regular\t0\t{self.font}"):
            self.assertEqual(utils._fc_match("Real Font:style=Regular"), os.path.realpath(self.font))
        argv = self.argv()
        self.assertEqual(argv[-2:], ["--", "Real Font:style=Regular"])

    def test_rejects_fontconfig_default_for_missing_family(self):
        with self.fake(f"DejaVu Sans\t0\t{self.font}"):
            self.assertEqual(utils._fc_match("Missing Family XYZ"), "")

    def test_rejects_nonzero_exit_empty_output_and_missing_file(self):
        with self.fake(f"Real Font\t0\t{self.font}", rc=1):
            self.assertEqual(utils._fc_match("Real Font"), "")
        with self.fake(""):
            self.assertEqual(utils._fc_match("Real Font"), "")
        with self.fake(f"Real Font\t0\t{self.tmp}/nope.ttf"):
            self.assertEqual(utils._fc_match("Real Font"), "")

    def test_rejects_non_font_files(self):
        with self.fake("Real Font\t0\t/etc/passwd"):
            self.assertEqual(utils._fc_match("Real Font"), "")

    def test_option_like_names_never_reach_fc_match(self):
        with self.fake("Real Font\t0\t/etc/passwd"):
            for name in ("--format=/etc/passwd", "-s", "--help", "-V"):
                self.assertEqual(utils._fc_match(name), "")
            self.assertFalse(os.path.exists(self.argv_log))

    def test_resolve_never_returns_injected_paths(self):
        # Even if fc-match were fooled, nothing outside a font file comes back.
        with self.fake("Real Font\t0\t/etc/passwd"):
            for name in ("--format=/etc/passwd", "/etc/passwd", "../../../../etc/passwd",
                         "../fonts/Charm-Regular.ttf", "..\\..\\etc\\passwd"):
                path = utils.resolve_font_path(name)
                self.assertNotEqual(os.path.realpath(path), "/etc/passwd")
                self.assertTrue(path.lower().endswith((".ttf", ".ttc", ".otf", ".otc")), path)


class TestBundledLookup(unittest.TestCase):
    """Bundled fonts: base name only, kept inside resource/fonts, font suffixes only (M2)."""

    def test_unsafe_names_fall_back_to_default(self):
        seen = []
        with patch.object(utils, "_fc_match", side_effect=lambda p: seen.append(p) or "/z.ttc"):
            for name in ("/etc/passwd", "--format=/etc/passwd", "../", "../Charm-Regular.ttf"):
                self.assertEqual(utils.resolve_font_path(name), "/z.ttc")
        self.assertEqual(set(seen), {const.DEFAULT_FONT_NAME})

    def test_symlink_out_of_font_dir_and_non_fonts_are_ignored(self):
        with tempfile.TemporaryDirectory() as fonts, tempfile.TemporaryDirectory() as outside:
            target = os.path.join(outside, "evil.ttf")
            shutil.copy(os.path.join(utils.font_dir(), "Charm-Regular.ttf"), target)
            os.symlink(target, os.path.join(fonts, "Linked.ttf"))
            with open(os.path.join(fonts, "notes.txt"), "w") as f:
                f.write("x")
            with patch.object(utils, "font_dir", return_value=fonts):
                self.assertEqual(utils._bundled_font("Linked.ttf"), "")
                self.assertEqual(utils._bundled_font("notes.txt"), "")
                self.assertEqual(utils._bundled_font("../" + os.path.basename(outside) + "/evil.ttf"), "")


class TestCollectionFaces(unittest.TestCase):
    """Collections: the requested (SC) face is handed to moviepy/PIL as face 0 (M3)."""

    def test_extract_face_from_collection(self):
        fonts = utils.font_dir()
        with tempfile.TemporaryDirectory() as tmp:
            ttc = os.path.join(tmp, "Charm.ttc")
            _build_collection(
                [os.path.join(fonts, "Charm-Regular.ttf"), os.path.join(fonts, "Charm-Bold.ttf")], ttc
            )
            self.assertEqual(ImageFont.truetype(ttc, 20).getname(), ("Charm", "Regular"))
            out = utils.extract_collection_face(ttc, 1, out_dir=os.path.join(tmp, "faces"))
            self.assertTrue(out.endswith(".ttf"))
            self.assertEqual(ImageFont.truetype(out, 20).getname(), ("Charm", "Bold"))
            self.assertEqual(utils.extract_collection_face(ttc, 2, out_dir=tmp), "")
            self.assertEqual(utils._preferred_face_index(ttc, "Charm"), 0)
            self.assertEqual(utils._preferred_face_index(ttc, "Charm:style=Bold"), 1)

    def test_system_candidate_collection_uses_sc_face(self):
        noto = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
        if not os.path.isfile(noto):
            self.skipTest("Noto Sans CJK collection not installed")
        self.assertNotEqual(ImageFont.truetype(noto, 20).getname()[0], "Noto Sans CJK SC")
        with patch.object(utils, "_fc_match", return_value=""), \
                patch.object(utils, "_SYSTEM_CJK_FONT_CANDIDATES", [noto]):
            path = utils.resolve_font_path(const.DEFAULT_FONT_NAME)
        self.assertEqual(ImageFont.truetype(path, 20).getname()[0], "Noto Sans CJK SC")

    def test_default_font_renders_simplified_chinese_face(self):
        if not shutil.which("fc-match") or not os.path.isfile(
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
        ):
            self.skipTest("fontconfig with Noto Sans CJK not installed")
        for name, style in ((const.DEFAULT_FONT_NAME, "Regular"), (const.DEFAULT_BOLD_FONT_NAME, "Bold")):
            path = utils.resolve_font_path(name)
            self.assertEqual(ImageFont.truetype(path, 20).getname(), ("Noto Sans CJK SC", style))


def _name_os2_face(names, weight):
    """A minimal sfnt with only 'name' (Windows, en-US) and 'OS/2' tables."""
    recs, strings = [], b""
    for nid, text in names.items():
        raw = text.encode("utf-16-be")
        recs.append(struct.pack(">HHHHHH", 3, 1, 0x409, nid, len(raw), len(strings)))
        strings += raw
    name = struct.pack(">HHH", 0, len(recs), 6 + 12 * len(recs)) + b"".join(recs) + strings
    os2 = struct.pack(">HhH", 4, 500, weight) + b"\0" * 90
    return [(b"OS/2", os2), (b"name", name)]


def _build_name_collection(faces, out):
    """A .ttc whose faces hold only name + OS/2 data (enough for face selection)."""
    header_len = 12 + 4 * len(faces)
    blobs, offsets, pos = [], [], header_len
    for tables in faces:
        dir_len = 12 + 16 * len(tables)
        data_pos = pos + dir_len
        head = struct.pack(">4sHHHH", b"\0\1\0\0", len(tables), 0, 0, 0)
        recs, body = b"", b""
        for tag, data in tables:
            recs += struct.pack(">4sIII", tag, 0, data_pos + len(body), len(data))
            body += data + b"\0" * (-len(data) % 4)
        offsets.append(pos)
        blobs.append(head + recs + body)
        pos += dir_len + len(body)
    with open(out, "wb") as f:
        f.write(b"ttcf" + struct.pack(">HHI", 1, 0, len(faces)))
        f.write(struct.pack(f">{len(faces)}I", *offsets))
        f.write(b"".join(blobs))


class TestSuperCollectionWeights(unittest.TestCase):
    """M5: the all-regions NotoSansCJK.ttc says "Regular" in name ID 2 for every
    weight; the face must be chosen by typographic style / weight too."""

    def test_regular_and_bold_not_thin(self):
        def face(region, style, weight):
            fam = f"Noto Sans CJK {region}"
            names = {1: fam if style in ("Regular", "Bold") else f"{fam} {style}",
                     2: style if style in ("Regular", "Bold") else "Regular",
                     16: fam, 17: style}
            return _name_os2_face(names, weight)

        layout = [("JP", "Thin", 100), ("JP", "Regular", 400), ("SC", "Thin", 100),
                  ("SC", "Light", 300), ("SC", "Regular", 400), ("SC", "Medium", 500),
                  ("SC", "Bold", 700), ("SC", "Black", 900)]
        with tempfile.TemporaryDirectory() as tmp:
            ttc = os.path.join(tmp, "NotoSansCJK.ttc")
            _build_name_collection([face(*f) for f in layout], ttc)
            pick = lambda pattern: layout[utils._preferred_face_index(ttc, pattern)]
            self.assertEqual(pick("Noto Sans CJK SC"), ("SC", "Regular", 400))
            self.assertEqual(pick(const.DEFAULT_FONT_NAME), ("SC", "Regular", 400))
            self.assertEqual(pick(const.DEFAULT_BOLD_FONT_NAME), ("SC", "Bold", 700))
            self.assertEqual(pick("Noto Sans CJK SC:style=Medium"), ("SC", "Medium", 500))
            self.assertEqual(pick("Noto Sans CJK SC:style=Light"), ("SC", "Light", 300))
            self.assertEqual(pick("Noto Sans CJK SC:style=SemiBold"), ("SC", "Bold", 700))
            # unknown family -> default family, Regular weight
            self.assertEqual(pick("Missing Family"), ("SC", "Regular", 400))


    @unittest.skipUnless(
        os.environ.get("MPT_NOTO_SUPER_OTC"),
        "set MPT_NOTO_SUPER_OTC to the all-regions NotoSansCJK.ttc (Sans2.004) to run",
    )
    def test_real_super_otc(self):
        ttc = os.environ["MPT_NOTO_SUPER_OTC"]
        with tempfile.TemporaryDirectory() as tmp:
            for pattern, want in (
                ("Noto Sans CJK SC", ("Noto Sans CJK SC", "Regular")),
                ("Noto Sans CJK SC:style=Bold", ("Noto Sans CJK SC", "Bold")),
            ):
                face = utils.extract_collection_face(ttc, utils._preferred_face_index(ttc, pattern), out_dir=tmp)
                self.assertEqual(ImageFont.truetype(face, 20).getname(), want)

class TestConcurrentFaceExtraction(unittest.TestCase):
    """M4: concurrent extractions of the same face never see a partial file."""

    def test_threads_extract_same_face(self):
        fonts = utils.font_dir()
        with tempfile.TemporaryDirectory() as tmp:
            ttc = os.path.join(tmp, "Charm.ttc")
            _build_collection(
                [os.path.join(fonts, "Charm-Regular.ttf"), os.path.join(fonts, "Charm-Bold.ttf")], ttc
            )
            out_dir = os.path.join(tmp, "faces")
            results, errors = [], []
            barrier = threading.Barrier(16)

            def work():
                try:
                    barrier.wait()
                    path = utils.extract_collection_face(ttc, 1, out_dir=out_dir)
                    results.append((path, ImageFont.truetype(path, 20).getname(), os.path.getsize(path)))
                except Exception as e:  # noqa: BLE001
                    errors.append(e)

            threads = [threading.Thread(target=work) for _ in range(16)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(errors, [])
            self.assertEqual(len(results), 16)
            self.assertEqual({r[0] for r in results}.__len__(), 1)
            self.assertEqual({r[1] for r in results}, {("Charm", "Bold")})
            self.assertEqual(len({r[2] for r in results}), 1)
            self.assertEqual([n for n in os.listdir(out_dir) if n.endswith(".tmp")], [])


class TestCachedFaceFiles(unittest.TestCase):
    """Cached faces get normal permissions, and older copies of a face are pruned."""

    def _ttc(self, tmp):
        fonts = utils.font_dir()
        ttc = os.path.join(tmp, "Charm.ttc")
        _build_collection(
            [os.path.join(fonts, "Charm-Regular.ttf"), os.path.join(fonts, "Charm-Bold.ttf")], ttc
        )
        return ttc

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_mode_is_0644_less_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            ttc = self._ttc(tmp)
            old = os.umask(0o027)
            try:
                path = utils.extract_collection_face(ttc, 1, out_dir=os.path.join(tmp, "faces"))
            finally:
                os.umask(old)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)
            path2 = utils.extract_collection_face(ttc, 0, out_dir=os.path.join(tmp, "faces2"))
            self.assertEqual(os.stat(path2).st_mode & 0o777, 0o644 & ~old)

    def test_older_copies_of_the_same_face_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            ttc = self._ttc(tmp)
            faces = os.path.join(tmp, "faces")
            os.makedirs(faces)
            stale = os.path.join(faces, "Charm-face1-123-456.ttf")
            other_face = os.path.join(faces, "Charm-face0-123-456.ttf")
            other_font = os.path.join(faces, "Other-face1-123-456.ttf")
            for p in (stale, other_face, other_font):
                with open(p, "wb") as f:
                    f.write(b"x")
            path = utils.extract_collection_face(ttc, 1, out_dir=faces)
            self.assertTrue(os.path.isfile(path))
            self.assertFalse(os.path.exists(stale))
            self.assertTrue(os.path.exists(other_face))
            self.assertTrue(os.path.exists(other_font))

    def test_same_named_sources_do_not_evict_each_other(self):
        # Two different files called Charm.ttc (e.g. a system and a per-user
        # install) each keep their cached face; only an older copy extracted
        # from the SAME file is pruned when that file changes.
        with tempfile.TemporaryDirectory() as tmp:
            a_dir, b_dir = os.path.join(tmp, "a"), os.path.join(tmp, "b")
            os.makedirs(a_dir)
            os.makedirs(b_dir)
            a, b = self._ttc(a_dir), self._ttc(b_dir)
            faces = os.path.join(tmp, "faces")
            pa = utils.extract_collection_face(a, 1, out_dir=faces)
            pb = utils.extract_collection_face(b, 1, out_dir=faces)
            self.assertNotEqual(pa, pb)
            # alternate calls are cache hits that leave both copies in place
            self.assertEqual(utils.extract_collection_face(a, 1, out_dir=faces), pa)
            self.assertEqual(utils.extract_collection_face(b, 1, out_dir=faces), pb)
            self.assertTrue(os.path.isfile(pa) and os.path.isfile(pb))
            # the source path is resolved, so a symlink to `a` shares a's cache
            if os.name != "nt":
                link = os.path.join(tmp, "Charm.ttc")
                os.symlink(a, link)
                self.assertEqual(utils.extract_collection_face(link, 1, out_dir=faces), pa)
            # `a` changes: its new copy replaces its old one; b's copy is untouched
            st = os.stat(a)
            os.utime(a, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
            pa2 = utils.extract_collection_face(a, 1, out_dir=faces)
            self.assertNotEqual(pa2, pa)
            self.assertFalse(os.path.exists(pa))
            self.assertTrue(os.path.isfile(pa2))
            self.assertTrue(os.path.isfile(pb))
            self.assertEqual(sorted(os.listdir(faces)), sorted([os.path.basename(pa2), os.path.basename(pb)]))


if __name__ == "__main__":
    unittest.main()
