"""keys.py: .env parsing + graceful missing-key behavior."""
from mira import keys


def test_parse_and_has(tmp_path):
    env = tmp_path / ".env"
    env.write_text('GROQ_API_KEY=gsk_abc123\n# comment\nMISTRAL_API_KEY="m-xyz"\nEMPTY=\n')
    data = keys.load(env_path=env, refresh=True)
    assert data["GROQ_API_KEY"] == "gsk_abc123"
    assert data["MISTRAL_API_KEY"] == "m-xyz"          # quotes stripped
    assert keys.has("GROQ_API_KEY", env_path=env)
    assert not keys.has("EMPTY", env_path=env)
    assert not keys.has("NIM_API_KEY", env_path=env)   # absent → False, no crash


def test_missing_and_configured(tmp_path):
    env = tmp_path / ".env"
    env.write_text("PEXELS_API_KEY=px\n")
    miss = keys.missing(["PEXELS_API_KEY", "SARVAM_API_KEY"], env_path=env)
    assert miss == ["SARVAM_API_KEY"]
    conf = keys.configured(env_path=env)
    assert conf["PEXELS_API_KEY"] is True
    assert conf["SARVAM_API_KEY"] is False
    assert set(keys.KNOWN_KEYS) <= set(conf)            # every known key reported
