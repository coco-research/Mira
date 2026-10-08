PUNCTUATIONS = [
    "?",
    ",",
    ".",
    "、",
    ";",
    ":",
    "!",
    "…",
    "？",
    "，",
    "。",
    "、",
    "；",
    "：",
    "！",
    "...",
    # 阿拉伯语常用标点也应作为自然断句点，避免脚本文本和 edge-tts
    # 返回的字幕停顿边界不一致，导致后续逐行匹配失败。
    "،",
    "؛",
    "؟",
]

TASK_STATE_FAILED = -1
TASK_STATE_COMPLETE = 1
TASK_STATE_PROCESSING = 4

FILE_TYPE_VIDEOS = ["mp4", "mov", "mkv", "webm"]
FILE_TYPE_IMAGES = ["jpg", "jpeg", "png", "bmp"]

# Subtitle fonts.
# Mira does not ship any CJK font binary. The default subtitle font is
# Noto Sans CJK (SIL OFL 1.1), looked up on the host system at render time
# (fontconfig on Linux, e.g. Debian/Ubuntu package `fonts-noto-cjk`).
# See resource/fonts/README.md.
DEFAULT_FONT_NAME = "Noto Sans CJK SC"
DEFAULT_BOLD_FONT_NAME = "Noto Sans CJK SC:style=Bold"
SYSTEM_FONT_CHOICES = [DEFAULT_FONT_NAME, DEFAULT_BOLD_FONT_NAME]

# Fonts that used to sit in resource/fonts/ but were removed because they are
# proprietary (lab-0062 legal review). Saved configs, API calls and CLI flags
# that still name them are mapped to the Noto Sans CJK equivalent.
REMOVED_FONT_ALIASES = {
    "MicrosoftYaHeiBold.ttc": DEFAULT_BOLD_FONT_NAME,
    "MicrosoftYaHeiNormal.ttc": DEFAULT_FONT_NAME,
    "STHeitiLight.ttc": "Noto Sans CJK SC:style=Light",
    "STHeitiMedium.ttc": "Noto Sans CJK SC:style=Medium",
    "UTM Kabel KT.ttf": DEFAULT_BOLD_FONT_NAME,
}
