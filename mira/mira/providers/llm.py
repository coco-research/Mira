"""LLM provider adapter — script generation.

Priority order (first that works wins):
  1. LM Studio — local, key-free, OpenAI-compatible at http://localhost:1234/v1.
     Auto-selects the first loaded chat model (skips ``*embed*`` models).
  2. Keyed overflow — GROQ → OPENROUTER → MISTRAL → NIM → GEMINI (optional).
  3. Offline template — deterministic generator keyed to the topic string.

No pip deps (stdlib urllib only); no network when LM Studio is down and no keys
are present. Set ``MIRA_LLM=offline`` to force the deterministic template path
(used by the test-suite so it never touches a live model).
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from typing import Any

from mira import config, keys
from mira.duration import words_for_duration, duration_for_words

_PROVIDER: str = "offline-template"


def provider_used() -> str:
    """Return the id of the provider last used by write_script()."""
    return _PROVIDER


def _offline_forced() -> bool:
    """True when MIRA_LLM=offline — skip LM Studio + keyed providers entirely."""
    return os.environ.get("MIRA_LLM", "").strip().lower() == "offline"


# ── offline template ─────────────────────────────────────────────────────────

def _template_script(topic: str, target_s: float) -> dict[str, Any]:
    """Deterministic template-based script generator (no network, no key)."""
    global _PROVIDER
    _PROVIDER = "offline-template"

    word_budget = words_for_duration(target_s)

    # Partition budget: hook gets ~20 %, rest goes to content scenes.
    hook_words = max(5, word_budget // 5)
    n_scenes = max(2, min(5, round(target_s / 2.5)))
    content_words = max(n_scenes * 5, word_budget - hook_words)
    words_per_scene = max(5, content_words // n_scenes)

    # Deterministic colours keyed to topic so the same topic always produces
    # the same script (useful for snapshot tests).
    h = int(hashlib.md5(topic.encode()).hexdigest(), 16)

    hooks = [
        f"You need to hear this about {topic}.",
        f"Here is the truth about {topic}.",
        f"Most people are wrong about {topic}.",
        f"This changes everything about {topic}.",
        f"The fastest way to understand {topic}.",
    ]
    hook_text = hooks[h % len(hooks)]
    hook_s = max(1.0, duration_for_words(hook_words))

    scene_templates = [
        f"First, {topic} saves you a huge amount of time.",
        f"Second, {topic} removes friction from your daily workflow.",
        f"Third, almost no one knows this shortcut in {topic}.",
        f"Fourth, you can start using {topic} completely for free.",
        f"The key insight about {topic} is that simplicity wins.",
        f"Here is a real example of {topic} in action.",
        f"Let that sink in — {topic} is already changing the game.",
    ]

    scenes: list[dict] = [{"text": hook_text, "seconds": round(hook_s, 3)}]

    for i in range(n_scenes):
        text = scene_templates[(h + i) % len(scene_templates)]
        s = max(1.0, duration_for_words(words_per_scene))
        scenes.append({"text": text, "seconds": round(s, 3)})

    # Stretch/shrink the last scene so the total lands exactly on target_s.
    total = sum(sc["seconds"] for sc in scenes)
    diff = target_s - total
    scenes[-1]["seconds"] = round(max(0.5, scenes[-1]["seconds"] + diff), 3)

    script_text = " ".join(sc["text"] for sc in scenes)
    return {"script": script_text, "scenes": scenes}


# ── LM Studio (local, key-free) ────────────────────────────────────────────────

# LM Studio ignores the bearer token but its OpenAI-compatible client still
# sends one; this conventional placeholder keeps the request well-formed.
_LMSTUDIO_TOKEN = "lm-studio"


def lmstudio_model(base_url: str | None = None, *, timeout: float = 2.0) -> str | None:
    """Return the id of the first loaded LM Studio chat model, or None.

    Hits ``/models`` and skips embedding models (``*embed*``). Any failure
    (server down, no model loaded, network error) returns None so callers can
    degrade to the next provider without raising.
    """
    base = base_url or config.DEFAULT_BASE_URLS.get("lmstudio", "")
    if not base:
        return None
    try:
        with urllib.request.urlopen(f"{base}/models", timeout=timeout) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None
    for entry in data.get("data", []):
        model_id = (entry.get("id") or "").strip()
        if model_id and "embed" not in model_id.lower():
            return model_id
    return None


# ── live providers ────────────────────────────────────────────────────────────

_LIVE_PROVIDERS = [
    ("GROQ_API_KEY",       "groq",       "groq",       "llama-3.1-8b-instant"),
    ("OPENROUTER_API_KEY", "openrouter",  "openrouter", "meta-llama/llama-3.1-8b-instruct:free"),
    ("MISTRAL_API_KEY",    "mistral",     "mistral",    "mistral-small-latest"),
    ("NIM_API_KEY",        "nim",         "nim",        "nvidia/llama-3.1-nemotron-nano-8b-v1"),
    ("GEMINI_API_KEY",     "gemini",      "gemini",     "gemini-2.0-flash"),
]


def _call_openai_compat(
    base_url: str,
    api_key: str,
    model: str,
    topic: str,
    target_s: float,
    channel: dict,
    *,
    max_tokens: int = 600,
    timeout: float = 20.0,
) -> dict[str, Any]:
    word_budget = words_for_duration(target_s)
    lang = channel.get("language", "en")

    system = (
        f"You are a faceless-short video scriptwriter. "
        f"Write a {lang} script for a ~{target_s:.0f}s video (~{word_budget} words). "
        f'Return ONLY valid JSON: {{"script": "...", "scenes": [{{"text": "...", "seconds": N}}]}}'
    )

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": f"Topic: {topic}"},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())

    content: str = (data["choices"][0]["message"].get("content") or "").strip()
    if not content:
        # Reasoning models can spend the whole budget on the reasoning channel
        # and emit empty content — treat as a failed call so we degrade cleanly.
        raise ValueError("empty completion content")
    # Strip markdown fences if the model wrapped the JSON.
    if content.startswith("```"):
        content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return _coerce_script(json.loads(content), topic, target_s)


def _coerce_script(raw: Any, topic: str, target_s: float) -> dict[str, Any]:
    """Normalise a model's JSON into ``{"script": str, "scenes": [...]}``.

    Tolerates common shape drift (scenes as plain strings, missing seconds,
    missing top-level script). Raises ValueError if there are no usable scenes
    so the caller degrades to the next provider / the offline template.
    """
    if not isinstance(raw, dict):
        raise ValueError("script payload is not an object")

    raw_scenes = raw.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise ValueError("script payload has no scenes")

    scenes: list[dict] = []
    for item in raw_scenes:
        if isinstance(item, str):
            text, seconds = item.strip(), None
        elif isinstance(item, dict):
            text = str(item.get("text") or item.get("line") or "").strip()
            seconds = item.get("seconds")
        else:
            continue
        if not text:
            continue
        try:
            seconds = float(seconds) if seconds is not None else 0.0
        except (TypeError, ValueError):
            seconds = 0.0
        scenes.append({"text": text, "seconds": seconds})

    if not scenes:
        raise ValueError("script payload has no usable scene text")

    # Fill missing/zero durations by splitting the remaining budget evenly.
    known = sum(s["seconds"] for s in scenes if s["seconds"] > 0)
    missing = [s for s in scenes if s["seconds"] <= 0]
    if missing:
        remaining = max(0.5 * len(missing), target_s - known)
        each = max(0.5, remaining / len(missing))
        for s in missing:
            s["seconds"] = round(each, 3)
    else:
        scenes = [{"text": s["text"], "seconds": round(s["seconds"], 3)} for s in scenes]

    script = str(raw.get("script") or "").strip() or " ".join(s["text"] for s in scenes)
    return {"script": script, "scenes": scenes}


# ── public API ────────────────────────────────────────────────────────────────

def write_script(topic: str, target_s: float, channel: dict) -> dict[str, Any]:
    """Generate a script for *topic* targeting *target_s* seconds.

    Returns ``{"script": str, "scenes": [{"text": str, "seconds": float}]}``.

    Tries LM Studio (local, key-free) first, then keyed providers in priority
    order when keys are present, then falls back to the deterministic offline
    template so tests never need network. ``MIRA_LLM=offline`` short-circuits
    straight to the template.
    """
    global _PROVIDER

    if _offline_forced():
        return _template_script(topic, target_s)

    # 1) LM Studio — local, no key required.
    base_url = config.DEFAULT_BASE_URLS.get("lmstudio", "")
    model = lmstudio_model(base_url)
    if model:
        try:
            result = _call_openai_compat(
                base_url=base_url,
                api_key=_LMSTUDIO_TOKEN,
                model=model,
                topic=topic,
                target_s=target_s,
                channel=channel,
                # A modest budget actually helps reasoning models: too large and
                # they fill the whole budget thinking and emit empty content.
                # 1000 is the proven sweet spot for a local ~12B (≈700 reasoning
                # tokens + room for the JSON). Local models are slow → long timeout.
                max_tokens=1000,
                timeout=150.0,
            )
            _PROVIDER = "lmstudio"
            return result
        except Exception:
            pass  # degrade to keyed overflow

    # 2) Keyed overflow providers.
    for key_name, provider_id, cfg_key, model in _LIVE_PROVIDERS:
        if keys.has(key_name):
            base_url = config.DEFAULT_BASE_URLS.get(cfg_key, "")
            api_key = keys.get(key_name) or ""
            try:
                result = _call_openai_compat(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    topic=topic,
                    target_s=target_s,
                    channel=channel,
                )
                _PROVIDER = provider_id
                return result
            except Exception:
                pass  # degrade to next provider

    # 3) Deterministic offline template.
    return _template_script(topic, target_s)
