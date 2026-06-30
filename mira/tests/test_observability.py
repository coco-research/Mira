"""Tests for mira.observability.RunLog — all local, no network."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest


class TestLogAndTail:
    def test_log_creates_file(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("test_event", message="hello")
        assert (tmp_path / "runs.jsonl").exists()

    def test_log_tail_round_trip(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("pipeline_start", channel="chn_aitools")
        log.log("pipeline_done", channel="chn_aitools", cost_usd=0.0)

        records = log.tail(10)
        assert len(records) == 2
        assert records[0]["event"] == "pipeline_start"
        assert records[1]["event"] == "pipeline_done"

    def test_tail_returns_correct_count(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        for i in range(10):
            log.log("tick", n=i)

        assert len(log.tail(3)) == 3
        assert len(log.tail(10)) == 10
        assert len(log.tail(100)) == 10   # only 10 exist

    def test_tail_on_empty_file_returns_empty_list(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        assert log.tail(5) == []

    def test_tail_missing_file_returns_empty_list(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "does_not_exist.jsonl")
        assert log.tail(5) == []

    def test_record_has_ts_and_event(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("my_event", foo="bar")
        rec = log.tail(1)[0]
        assert "ts" in rec
        assert rec["event"] == "my_event"

    def test_extra_fields_preserved(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("stats", views=1234, subs=42)
        rec = log.tail(1)[0]
        assert rec["views"] == 1234
        assert rec["subs"] == 42

    def test_file_is_valid_jsonl(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("a")
        log.log("b")
        lines = (tmp_path / "runs.jsonl").read_text().splitlines()
        assert len(lines) == 2
        for ln in lines:
            json.loads(ln)   # must not raise

    def test_parent_dir_created_automatically(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        nested = tmp_path / "a" / "b" / "c" / "runs.jsonl"
        log = RunLog(nested)
        log.log("test")
        assert nested.exists()


class TestSecretRedaction:
    @pytest.mark.parametrize("field_name", [
        "api_key", "API_KEY", "youtube_api_key",
        "token", "access_token", "IG_ACCESS_TOKEN",
        "secret", "client_secret",
        "password", "db_password",
    ])
    def test_secret_field_redacted_to_stars(self, tmp_path: Path, field_name: str) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("auth_attempt", **{field_name: "super-secret-value-12345"})

        # Check the raw file to confirm the secret never hit disk.
        raw = (tmp_path / "runs.jsonl").read_text()
        assert "super-secret-value-12345" not in raw

        rec = log.tail(1)[0]
        assert rec[field_name] == "***"

    def test_non_secret_field_not_redacted(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("info", channel="chn_aitools", cost_usd=1.23)
        rec = log.tail(1)[0]
        assert rec["channel"] == "chn_aitools"
        assert rec["cost_usd"] == 1.23

    def test_redacted_value_written_as_stars_in_file(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        log.log("post", api_key="real-key-here")
        raw_line = (tmp_path / "runs.jsonl").read_text().strip()
        parsed = json.loads(raw_line)
        assert parsed["api_key"] == "***"


class TestTimedContextManager:
    def test_timed_logs_duration_ms(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        with log.timed("render_stage"):
            pass

        rec = log.tail(1)[0]
        assert rec["event"] == "render_stage"
        assert "duration_ms" in rec
        assert rec["duration_ms"] >= 0

    def test_timed_duration_ms_is_non_negative(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        with log.timed("quick_op"):
            time.sleep(0.01)

        rec = log.tail(1)[0]
        assert rec["duration_ms"] >= 0

    def test_timed_captures_elapsed_time(self, tmp_path: Path) -> None:
        """A 50 ms sleep should produce duration_ms >= 40."""
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        with log.timed("slow_op"):
            time.sleep(0.05)

        rec = log.tail(1)[0]
        assert rec["duration_ms"] >= 40, f"Expected >= 40ms, got {rec['duration_ms']}"

    def test_timed_logs_even_on_exception(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        with pytest.raises(ValueError):
            with log.timed("failing_stage"):
                raise ValueError("oops")

        rec = log.tail(1)[0]
        assert rec["event"] == "failing_stage"
        assert "duration_ms" in rec

    def test_timed_passes_extra_fields(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        with log.timed("generate", channel="chn_aitools"):
            pass

        rec = log.tail(1)[0]
        assert rec["channel"] == "chn_aitools"

    def test_timed_redacts_secret_fields(self, tmp_path: Path) -> None:
        from mira.observability import RunLog

        log = RunLog(tmp_path / "runs.jsonl")
        with log.timed("api_call", api_key="should-be-redacted"):
            pass

        rec = log.tail(1)[0]
        assert rec["api_key"] == "***"
