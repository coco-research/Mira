"""Contract tests: golden fixtures round-trip through the schemas (SCHEMA.md)."""
from mira import fixtures as fx
from mira import schemas as s


def test_channels_validate_and_roundtrip():
    assert len(fx.CHANNELS) == 3
    for d in fx.CHANNELS:
        c = s.Channel.from_dict(d)
        assert c.validate() == [], f"{c.id}: {c.validate()}"
        # round-trip preserves declared keys
        rt = c.to_dict()
        for k in d:
            assert k in rt


def test_videos_validate():
    ids = {v["id"] for v in fx.VIDEOS}
    assert "vid_a1b2" in ids and "vid_p5q6" in ids
    for d in fx.VIDEOS:
        v = s.Video.from_dict(d)
        assert v.validate() == [], f"{v.id}: {v.validate()}"


def test_support_envelope_llm_pool_has_new_free_providers():
    llm = fx.SUPPORT_ENVELOPE["providers"]["llm"]
    for p in ("mistral", "groq", "cerebras", "cloudflare", "github-models"):
        assert p in llm, f"missing free provider {p}"
    # every listed llm id is a known provider id
    for p in llm:
        assert p in s.LLM_PROVIDERS


def test_unknown_keys_are_filtered():
    c = s.Channel.from_dict({"id": "x", "name": "y", "bogus": 1})
    assert not hasattr(c, "bogus")
