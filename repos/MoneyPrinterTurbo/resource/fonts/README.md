# Subtitle fonts

Mira does not bundle any CJK font file. The default subtitle font is
**Noto Sans CJK** (SIL Open Font License 1.1), which is looked up on the host
at render time:

1. A file with the configured name in this folder (for example `Charm-Regular.ttf`,
   or any `.ttf`/`.ttc`/`.otf` you add yourself).
2. Otherwise the configured name is passed to fontconfig (`fc-match`), so a
   family name such as `Noto Sans CJK SC` or `Noto Sans CJK SC:style=Bold` works.
3. Otherwise well-known Noto Sans CJK locations, then the operating system's own
   CJK font (PingFang on macOS, Microsoft YaHei / SimHei on Windows), read from
   your system and never shipped with Mira.
4. As a last resort, the bundled `Charm-Regular.ttf` (OFL; Latin and Thai only).

Install Noto Sans CJK if you render Chinese, Japanese or Korean subtitles:

- Debian/Ubuntu: `sudo apt install fonts-noto-cjk` (the Docker images do this)
- Fedora: `sudo dnf install google-noto-sans-cjk-fonts`
- macOS: `brew install --cask font-noto-sans-cjk`
- Windows: install Noto Sans SC from https://fonts.google.com/noto/specimen/Noto+Sans+SC

The logic lives in `app/utils/utils.py` (`resolve_font_path`).

## Removed fonts

`MicrosoftYaHeiBold.ttc`, `MicrosoftYaHeiNormal.ttc`, `STHeitiLight.ttc`,
`STHeitiMedium.ttc` and `UTM Kabel KT.ttf` used to be in this folder. They are
proprietary and were removed (lab-0062 legal review). Configs, API calls or CLI
flags that still name them are mapped to Noto Sans CJK automatically (see
`REMOVED_FONT_ALIASES` in `app/models/const.py`).

## Bundled

- `Charm-Regular.ttf`, `Charm-Bold.ttf`: Charm, Copyright 2018 The Charm Project Authors, SIL Open Font License 1.1.
  Licence text: `OFL-charm.txt` (from google/fonts `ofl/charm/OFL.txt` @ 053f0ca6).
