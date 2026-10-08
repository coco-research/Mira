import json
import locale
import os
import re
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
import threading
from typing import Any
from uuid import uuid4

from loguru import logger

from app.models import const


def get_response(status: int, data: Any = None, message: str = ""):
    obj = {
        "status": status,
    }
    if data:
        obj["data"] = data
    if message:
        obj["message"] = message
    return obj


def to_json(obj):
    try:
        # Define a helper function to handle different types of objects
        def serialize(o):
            # If the object is a serializable type, return it directly
            if isinstance(o, (int, float, bool, str)) or o is None:
                return o
            # If the object is binary data, convert it to a base64-encoded string
            elif isinstance(o, bytes):
                return "*** binary data ***"
            # If the object is a dictionary, recursively process each key-value pair
            elif isinstance(o, dict):
                return {k: serialize(v) for k, v in o.items()}
            # If the object is a list or tuple, recursively process each element
            elif isinstance(o, (list, tuple)):
                return [serialize(item) for item in o]
            # If the object is a custom type, attempt to return its __dict__ attribute
            elif hasattr(o, "__dict__"):
                return serialize(o.__dict__)
            # Return None for other cases (or choose to raise an exception)
            else:
                return None

        # Use the serialize function to process the input object
        serialized_obj = serialize(obj)

        # Serialize the processed object into a JSON string
        return json.dumps(serialized_obj, ensure_ascii=False, indent=4)
    except Exception as e:
        logger.error(f"failed to serialize object to json: {str(e)}")
        return None


def get_uuid(remove_hyphen: bool = False):
    u = str(uuid4())
    if remove_hyphen:
        u = u.replace("-", "")
    return u


def root_dir():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def storage_dir(sub_dir: str = "", create: bool = False):
    d = os.path.join(root_dir(), "storage")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if create and not os.path.exists(d):
        os.makedirs(d)

    return d


def resource_dir(sub_dir: str = ""):
    d = os.path.join(root_dir(), "resource")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    return d


def task_dir(sub_dir: str = ""):
    d = os.path.join(storage_dir(), "tasks")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


def font_dir(sub_dir: str = ""):
    d = resource_dir("fonts")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


# Font files that ship with Mira (OFL) and are used when no system font
# can be found, so rendering never crashes. Charm covers Latin and Thai only.
_FALLBACK_BUNDLED_FONTS = ["Charm-Regular.ttf"]

# Only these files are ever handed to FreeType (PIL / moviepy).
_FONT_SUFFIXES = (".ttf", ".ttc", ".otf", ".otc")

# Well-known locations of Noto Sans CJK and of the platform's own CJK UI font.
# These are read from the user's machine at runtime; Mira does not ship them.
# Single-language "SC" files come first: they hold only Simplified Chinese
# glyph forms, so no face selection is needed. For a collection (.ttc/.otc)
# the Simplified Chinese face is picked by name (see _preferred_face_index).
_LOCALAPPDATA_FONTS = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/AppData/Local")),
    "Microsoft",
    "Windows",
    "Fonts",
)
_SYSTEM_CJK_FONT_CANDIDATES = [
    # Noto Sans CJK SC, single-language files (SIL OFL 1.1). macOS:
    # `brew install --cask font-noto-sans-cjk-sc`; Linux: Noto SubsetOTF / -extra.
    os.path.expanduser("~/Library/Fonts/NotoSansCJKsc-Regular.otf"),
    "/Library/Fonts/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf",
    os.path.expanduser("~/.local/share/fonts/NotoSansCJKsc-Regular.otf"),
    # Noto Sans SC from Google Fonts (Windows: system-wide or per-user install)
    "C:/Windows/Fonts/NotoSansSC-VariableFont_wght.ttf",
    os.path.join(_LOCALAPPDATA_FONTS, "NotoSansSC-VariableFont_wght.ttf"),
    # Noto Sans CJK collections (all regions in one file)
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/OTF/NotoSansCJK-Regular.ttc",
    "/usr/local/share/fonts/NotoSansCJK-Regular.ttc",
    os.path.expanduser("~/.local/share/fonts/NotoSansCJK-Regular.ttc"),
    # macOS: `brew install --cask font-noto-sans-cjk` installs NotoSansCJK.ttc
    os.path.expanduser("~/Library/Fonts/NotoSansCJK.ttc"),
    "/Library/Fonts/NotoSansCJK.ttc",
    os.path.expanduser("~/Library/Fonts/NotoSansCJK-Regular.ttc"),
    "/Library/Fonts/NotoSansCJK-Regular.ttc",
    # The operating system's own CJK font, if Noto is not installed.
    # PingFang is at this path on macOS 14 and earlier only; macOS 15 moved it
    # into a versioned asset folder with no stable path (fc-match still finds it
    # when fontconfig is installed).
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
]


def _font_file(path: str) -> str:
    """Return `path` if it resolves to a regular font file, else ""."""
    if not path:
        return ""
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError):
        return ""
    if real.lower().endswith(_FONT_SUFFIXES) and os.path.isfile(real):
        return path
    return ""


def _is_safe_font_name(name: str) -> bool:
    """A font setting is a family pattern or a bare file name, never a path or option."""
    return bool(name) and not (
        name.startswith("-")
        or "/" in name
        or "\\" in name
        or "\x00" in name
        or name in (".", "..")
    )


def _bundled_font(name: str) -> str:
    """A font file in resource/fonts/, looked up by base name and kept inside that dir."""
    base = os.path.basename(name)
    if not base:
        return ""
    root = os.path.realpath(font_dir())
    path = os.path.join(root, base)
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError):
        return ""
    if not real.startswith(root + os.sep):
        return ""
    return path if _font_file(path) else ""


def _requested_family(pattern: str) -> str:
    return pattern.split(":", 1)[0].strip().replace("\\", "").lower()


def _fc_match_face(pattern: str) -> tuple[str, int]:
    """
    Return (file, face index) that fontconfig picks for `pattern`, or ("", 0).

    fc-match always prints *some* font (fontconfig's default) even for a
    family that is not installed, so the match is accepted only when the
    requested family is one of the families fontconfig reports.
    """
    if not _is_safe_font_name(pattern):
        return "", 0
    fc_match = shutil.which("fc-match")
    if not fc_match:
        return "", 0
    try:
        result = subprocess.run(
            [fc_match, "-f", "%{family}\t%{index}\t%{file}", "--", pattern],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"fc-match failed for {pattern!r}: {e}")
        return "", 0
    if result.returncode != 0:
        return "", 0
    parts = result.stdout.strip().split("\t")
    if len(parts) != 3:
        return "", 0
    families, index, path = parts
    wanted = _requested_family(pattern)
    got = {f.strip().replace("\\", "").lower() for f in families.split(",")}
    if not wanted or wanted not in got:
        return "", 0
    path = _font_file(path.strip())
    if not path:
        return "", 0
    try:
        face = int(index) & 0xFFFF  # high bits are variable-font instance numbers
    except ValueError:
        face = 0
    return os.path.realpath(path), face


def _fc_match(pattern: str) -> str:
    """Return the font file fontconfig picks for `pattern`, or "" if unavailable."""
    path, face = _fc_match_face(pattern)
    return _face_file(path, face) if path else ""


def _read_collection_offsets(data: bytes) -> list[int]:
    import struct

    if len(data) < 12 or data[:4] != b"ttcf":
        return []
    (count,) = struct.unpack(">I", data[8:12])
    if count > 256 or len(data) < 12 + 4 * count:
        return []
    return list(struct.unpack(f">{count}I", data[12 : 12 + 4 * count]))


def _face_names(data: bytes, offset: int) -> tuple[set[str], str, int]:
    """
    (family names, style, weight) of the sfnt face at `offset`.

    Families come from name IDs 1 and 16. The style is the typographic
    subfamily (name ID 17) when present, else name ID 2: in the all-regions
    Noto Sans CJK super-OTC every weight says "Regular" in ID 2 and the real
    weight ("Thin", "Medium", ...) only in ID 17. The weight is OS/2
    usWeightClass (0 if missing).
    """
    import struct

    families: set[str] = set()
    sub = {2: "", 17: ""}
    weight = 0
    try:
        (num_tables,) = struct.unpack(">H", data[offset + 4 : offset + 6])
        for i in range(num_tables):
            rec = offset + 12 + 16 * i
            tag = data[rec : rec + 4]
            (t_off,) = struct.unpack(">I", data[rec + 8 : rec + 12])
            if tag == b"OS/2":
                (weight,) = struct.unpack(">H", data[t_off + 4 : t_off + 6])
                continue
            if tag != b"name":
                continue
            _, count, str_off = struct.unpack(">HHH", data[t_off : t_off + 6])
            for j in range(count):
                r = t_off + 6 + 12 * j
                pid, eid, lang, nid, length, n_off = struct.unpack(
                    ">HHHHHH", data[r : r + 12]
                )
                if nid not in (1, 2, 16, 17):
                    continue
                raw = data[t_off + str_off + n_off : t_off + str_off + n_off + length]
                if pid in (0, 3):
                    text = raw.decode("utf-16-be", "ignore")
                elif pid == 1 and eid == 0:
                    text = raw.decode("latin-1", "ignore")
                else:
                    continue
                text = text.strip().lower()
                if not text:
                    continue
                if nid in (1, 16):
                    families.add(text)
                elif not sub[nid] or (pid == 3 and lang == 0x409):
                    sub[nid] = text
    except struct.error:
        pass
    return families, sub[17] or sub[2], weight


# CSS / OpenType weight for fontconfig style names
_STYLE_WEIGHTS = {
    "thin": 100, "hairline": 100, "extralight": 200, "ultralight": 200,
    "light": 300, "demilight": 350, "semilight": 350, "regular": 400,
    "normal": 400, "book": 400, "medium": 500, "semibold": 600,
    "demibold": 600, "bold": 700, "extrabold": 800, "ultrabold": 800,
    "black": 900, "heavy": 900,
}


def _requested_style(pattern: str) -> str:
    m = re.search(r":style=([^:]+)", pattern, flags=re.IGNORECASE)
    return m.group(1).strip().lower() if m else "regular"


def _preferred_face_index(path: str, pattern: str) -> int:
    """
    Pick the face of a collection for a fontconfig-style `pattern`: the
    requested family, else the default (Noto Sans CJK SC), else a Simplified
    Chinese ("SC") face, else face 0. Within those faces, the requested style
    wins (Regular unless ":style=..." says otherwise): an exact style-name
    match, else the face whose weight is closest to the style's weight.
    Non-collections use face 0.
    """
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return 0
    offsets = _read_collection_offsets(data)
    if len(offsets) < 2:
        return 0
    faces = [_face_names(data, o) for o in offsets]
    style = _requested_style(pattern)
    target = _STYLE_WEIGHTS.get(style.replace(" ", "").replace("-", ""), 400)

    def best(matches):
        if not matches:
            return None
        for i in matches:
            if faces[i][1] == style:
                return i
        # nearest weight; ties go heavier for target >= 400, lighter below
        # (the CSS font-matching rule)
        sign = -1 if target >= 400 else 1
        return min(
            matches,
            key=lambda i: (abs((faces[i][2] or 400) - target), sign * (faces[i][2] or 400), i),
        )

    for want in (_requested_family(pattern), const.DEFAULT_FONT_NAME.lower()):
        hit = best([i for i, (fams, _, _) in enumerate(faces) if want in fams])
        if hit is not None:
            return hit
    hit = best([i for i, (fams, _, _) in enumerate(faces) if any("sc" in n.split() for n in fams)])
    return hit if hit is not None else 0


def _current_umask() -> int:
    """The process umask. Read from /proc where available, because os.umask
    can only be read by setting it, which briefly changes it for every thread."""
    try:
        with open("/proc/self/status", encoding="ascii") as f:
            for line in f:
                if line.startswith("Umask:"):
                    return int(line.split()[1], 8)
    except (OSError, ValueError, IndexError):
        pass
    with _UMASK_LOCK:
        mask = os.umask(0o022)
        os.umask(mask)
    return mask


_UMASK_LOCK = threading.Lock()


def _remove_stale_faces(out_dir: str, prefix: str, ext: str, keep: str) -> None:
    """
    Delete older cached copies of the same face (same font file name and face
    index, but an earlier size/mtime of the source font), so the cache does not
    grow each time a system font is updated. Best effort: a copy another
    process still has open, or cannot remove, is left alone.
    """
    try:
        names = os.listdir(out_dir)
    except OSError:
        return
    keep_name = os.path.basename(keep)
    for name in names:
        if name == keep_name or not name.startswith(prefix) or not name.endswith(ext):
            continue
        # only "<stem>-face<index>-<size>-<mtime_ns><ext>", not another face index
        if not re.fullmatch(re.escape(prefix) + r"\d+-\d+" + re.escape(ext), name):
            continue
        try:
            os.unlink(os.path.join(out_dir, name))
        except OSError:
            pass


def extract_collection_face(path: str, index: int, out_dir: str = "") -> str:
    """
    Write face `index` of a .ttc/.otc collection as a standalone font file and
    return its path (cached). moviepy's TextClip and PIL's ImageFont.truetype
    load face 0 unless told otherwise, so the requested face is given its own
    file. Returns "" if `path` is not a collection or the index is invalid.
    """
    import struct

    with open(path, "rb") as f:
        data = f.read()
    offsets = _read_collection_offsets(data)
    if not 0 <= index < len(offsets):
        return ""
    base = offsets[index]
    sfnt_version = data[base : base + 4]
    (num_tables,) = struct.unpack(">H", data[base + 4 : base + 6])
    records = []
    for i in range(num_tables):
        rec = base + 12 + 16 * i
        tag, checksum, t_off, t_len = struct.unpack(">4sIII", data[rec : rec + 16])
        if t_off + t_len > len(data):
            return ""
        records.append((tag, checksum, t_off, t_len))
    records.sort(key=lambda r: r[0])

    st = os.stat(path)
    ext = ".otf" if sfnt_version == b"OTTO" else ".ttf"
    stem = os.path.splitext(os.path.basename(path))[0]
    out_dir = out_dir or storage_dir("font_faces", create=True)
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{stem}-face{index}-{st.st_size}-{st.st_mtime_ns}{ext}")
    if os.path.isfile(out):
        return out

    header_len = 12 + 16 * num_tables
    head = bytearray(data[base : base + 12])
    table_dir = bytearray()
    body = bytearray()
    pos = header_len
    for tag, checksum, t_off, t_len in records:
        table_dir += struct.pack(">4sIII", tag, checksum, pos, t_len)
        chunk = data[t_off : t_off + t_len]
        chunk += b"\0" * (-len(chunk) % 4)
        body += chunk
        pos += len(chunk)
    # A unique temp file per write (same directory, so os.replace is atomic):
    # concurrent renders may extract the same face at once, and readers only
    # ever see either no file or a complete one.
    fd, tmp = tempfile.mkstemp(prefix=f".{stem}-face{index}-", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(bytes(head) + bytes(table_dir) + bytes(body))
        # mkstemp creates the file 0o600; give the cached face the usual
        # 0o644 (less the umask), like any other file the app writes.
        os.chmod(tmp, 0o644 & ~_current_umask())
        os.replace(tmp, out)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _remove_stale_faces(out_dir, f"{stem}-face{index}-", ext, keep=out)
    return out


def _face_file(path: str, index: int) -> str:
    """`path` itself for face 0 / single fonts; else a standalone copy of that face."""
    if index <= 0 or not path.lower().endswith((".ttc", ".otc")):
        return path
    try:
        out = extract_collection_face(path, index)
    except Exception as e:
        logger.warning(f"could not extract face {index} of {path}: {e}")
        return path
    return out or path


def resolve_font_path(font_name: str = "") -> str:
    """
    Turn a subtitle font setting into a font file path at render time.

    `font_name` is a fontconfig family pattern (e.g. "Noto Sans CJK SC" or
    "Noto Sans CJK SC:style=Bold") or the bare name of a file in
    resource/fonts/. Paths, names with path separators and names that start
    with "-" are rejected (they reach us from the API) and the default is
    used instead.

    Order: a file in resource/fonts/, then the system font named by
    `font_name` via fontconfig (only if fontconfig reports that family), then
    well-known Noto Sans CJK / OS CJK font locations, then a bundled OFL font.
    For font collections the Simplified Chinese face is returned as its own
    file, since moviepy and PIL otherwise load face 0 (Japanese forms in
    Noto Sans CJK). Names of the proprietary fonts removed from
    resource/fonts/ are mapped to Noto Sans CJK, so older configs keep working.
    """
    name = (font_name or "").strip() or const.DEFAULT_FONT_NAME
    if not _is_safe_font_name(name):
        logger.warning(f"ignoring unsafe font setting {name!r}; using {const.DEFAULT_FONT_NAME!r}")
        name = const.DEFAULT_FONT_NAME
    if name in const.REMOVED_FONT_ALIASES:
        alias = const.REMOVED_FONT_ALIASES[name]
        logger.info(f"font {name!r} is no longer bundled; using system font {alias!r}")
        name = alias

    bundled = _bundled_font(name)
    if bundled:
        return bundled

    path = _fc_match(name)
    if path:
        return path

    bold = "bold" in name.lower()
    candidates = []
    for candidate in _SYSTEM_CJK_FONT_CANDIDATES:
        if bold and "Regular" in os.path.basename(candidate):
            candidates.append(candidate.replace("Regular", "Bold"))
        candidates.append(candidate)
    for candidate in candidates:
        if _font_file(candidate):
            logger.warning(
                f"font {name!r} not found via fontconfig; using system font {candidate}"
            )
            return _face_file(candidate, _preferred_face_index(candidate, name))

    for fallback in _FALLBACK_BUNDLED_FONTS:
        path = _bundled_font(fallback)
        if path:
            logger.warning(
                f"font {name!r} not found and no CJK system font installed; "
                f"falling back to bundled {fallback} (no CJK glyphs). "
                "Install Noto Sans CJK (e.g. `apt install fonts-noto-cjk`)."
            )
            return path

    logger.error(f"no usable subtitle font found for {name!r}")
    return os.path.join(font_dir(), _FALLBACK_BUNDLED_FONTS[0])


def song_dir(sub_dir: str = ""):
    d = resource_dir("songs")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


def public_dir(sub_dir: str = ""):
    d = resource_dir("public")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


def get_ffmpeg_binary() -> str:
    """
    解析当前进程应该使用的 FFmpeg 可执行文件。

    增加原因：
    1. 视频编码、静音音频生成、pydub 音频转码都依赖 FFmpeg；
    2. Windows 便携包、Docker 和用户自定义安装目录经常出现 PATH 不一致；
    3. 集中解析可以让所有调用方使用同一套优先级，减少某条链路能跑、
       另一条链路找不到 FFmpeg 的现场问题。

    优先级：
    1. IMAGEIO_FFMPEG_EXE：MoviePy/imageio 约定的显式配置；
    2. 系统 PATH 中的 ffmpeg；
    3. imageio-ffmpeg 依赖提供的内置二进制；
    4. 字符串 "ffmpeg" 兜底，交给 subprocess 在运行时暴露更具体错误。
    """
    configured_ffmpeg = os.environ.get("IMAGEIO_FFMPEG_EXE")
    if configured_ffmpeg:
        return configured_ffmpeg

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    try:
        import imageio_ffmpeg

        bundled_ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        if bundled_ffmpeg:
            return bundled_ffmpeg
    except Exception as exc:
        logger.warning(f"failed to resolve bundled ffmpeg binary: {str(exc)}")

    return "ffmpeg"


def run_in_background(func, *args, **kwargs):
    def run():
        try:
            func(*args, **kwargs)
        except Exception as e:
            logger.error(f"run_in_background error: {e}", exc_info=True)

    thread = threading.Thread(target=run, daemon=False)
    thread.start()
    return thread


def time_convert_seconds_to_hmsm(seconds) -> str:
    hours = int(seconds // 3600)
    seconds = seconds % 3600
    minutes = int(seconds // 60)
    milliseconds = int(seconds * 1000) % 1000
    seconds = int(seconds % 60)
    return "{:02d}:{:02d}:{:02d},{:03d}".format(hours, minutes, seconds, milliseconds)


def text_to_srt(idx: int, msg: str, start_time: float, end_time: float) -> str:
    start_time = time_convert_seconds_to_hmsm(start_time)
    end_time = time_convert_seconds_to_hmsm(end_time)
    srt = """%d
%s --> %s
%s
        """ % (
        idx,
        start_time,
        end_time,
        msg,
    )
    return srt


def str_contains_punctuation(word):
    for p in const.PUNCTUATIONS:
        if p in word:
            return True
    return False


def split_string_by_punctuations(s):
    result = []
    txt = ""

    previous_char = ""
    next_char = ""
    for i in range(len(s)):
        char = s[i]
        if char == "\n":
            result.append(txt.strip())
            txt = ""
            continue

        if i > 0:
            previous_char = s[i - 1]
        if i < len(s) - 1:
            next_char = s[i + 1]

        if char == "." and previous_char.isdigit() and next_char.isdigit():
            # # In the case of "withdraw 10,000, charged at 2.5% fee", the dot in "2.5" should not be treated as a line break marker
            txt += char
            continue

        if char == "," and previous_char.isdigit() and next_char.isdigit():
            # 英文数字里的千分位逗号不是断句符，例如 "1,000 years"。
            # Edge TTS 的 word boundary 通常会把这种数字整体作为连续内容返回；
            # 如果这里拆成 "1" 和 "000 years"，后续字幕聚合会无法匹配脚本原文，
            # 进而错误回退到 Whisper。
            txt += char
            continue

        if char not in const.PUNCTUATIONS:
            txt += char
        else:
            result.append(txt.strip())
            txt = ""
    result.append(txt.strip())
    # filter empty string
    result = list(filter(None, result))
    return result


def normalize_script_for_subtitle_matching(video_script: str) -> str:
    """
    清理字幕匹配前的脚本文本。

    用户可能手动输入 Markdown 分隔符、标题强调或 `_` 这类格式符号。
    这些字符通常不会出现在 TTS/Whisper 的识别结果里；如果继续参与
    字幕逐行匹配，脚本行数量会大于真实字幕行数量，最终可能补出
    `00:00:00,000 --> 00:00:00,000`，导致剪辑软件无法导入 SRT。
    """
    video_script = video_script or ""
    underscore_count = video_script.count("_")
    video_script = video_script.replace("_", "")
    cleaned_lines = []
    removed_separator_lines = 0
    for line in video_script.splitlines():
        line = line.strip()
        # Markdown 分隔符或强调符号单独成行时不会被 TTS 朗读，必须从
        # 脚本行里移除，避免字幕聚合卡在这类“不可发声”的目标行上。
        if re.fullmatch(r"[-*_]{3,}", line):
            removed_separator_lines += 1
            continue
        cleaned_lines.append(line)

    normalized_script = "\n".join(cleaned_lines).strip()
    if underscore_count or removed_separator_lines:
        logger.debug(
            "normalized script for subtitle matching, "
            f"removed underscores: {underscore_count}, "
            f"removed markdown separator lines: {removed_separator_lines}"
        )
    return normalized_script


def md5(text):
    import hashlib

    return hashlib.md5(text.encode("utf-8")).hexdigest()


def get_system_locale():
    try:
        loc = locale.getdefaultlocale()
        # zh_CN, zh_TW return zh
        # en_US, en_GB return en
        language_code = loc[0].split("_")[0]
        return language_code
    except Exception:
        return "en"


@lru_cache(maxsize=None)
def load_locales(i18n_dir):
    # WebUI 每次交互都会触发 Streamlit 重新执行脚本，语言文件运行期不会变化，
    # 因此缓存解析结果，避免反复读取和解析所有 i18n JSON 文件。
    _locales = {}
    for root, dirs, files in os.walk(i18n_dir):
        for file in files:
            if file.endswith(".json"):
                lang = file.split(".")[0]
                with open(os.path.join(root, file), "r", encoding="utf-8") as f:
                    _locales[lang] = json.loads(f.read())
    return _locales


def parse_extension(filename):
    return Path(filename).suffix.lower().lstrip('.')
