"""Tests for mira.providers.analytics — all offline, no network."""
from __future__ import annotations

import pytest


STAT_KEYS = {"views_28d", "retention_pct", "subs", "watch_hours", "shorts_views_90d"}


class TestPullDryRun:
    def test_returns_all_five_keys(self) -> None:
        from mira.providers.analytics import pull

        stats = pull("chn_aitools", dry_run=True)
        assert set(stats.keys()) == STAT_KEYS

    def test_deterministic_same_channel(self) -> None:
        from mira.providers.analytics import pull

        s1 = pull("chn_aitools", dry_run=True)
        s2 = pull("chn_aitools", dry_run=True)
        assert s1 == s2

    def test_different_channels_differ(self) -> None:
        from mira.providers.analytics import pull

        s1 = pull("chn_aitools", dry_run=True)
        s2 = pull("chn_deepdives", dry_run=True)
        assert s1 != s2

    def test_default_is_dry_run(self) -> None:
        """pull() without dry_run kwarg must NOT raise and must return all keys."""
        from mira.providers.analytics import pull

        stats = pull("chn_quickwins")
        assert STAT_KEYS.issubset(stats.keys())

    def test_views_28d_positive(self) -> None:
        from mira.providers.analytics import pull

        stats = pull("chn_aitools", dry_run=True)
        assert stats["views_28d"] > 0

    def test_retention_pct_in_range(self) -> None:
        from mira.providers.analytics import pull

        stats = pull("chn_aitools", dry_run=True)
        assert 0.0 < stats["retention_pct"] <= 100.0

    def test_subs_positive(self) -> None:
        from mira.providers.analytics import pull

        stats = pull("chn_aitools", dry_run=True)
        assert stats["subs"] > 0

    def test_watch_hours_positive(self) -> None:
        from mira.providers.analytics import pull

        stats = pull("chn_aitools", dry_run=True)
        assert stats["watch_hours"] > 0

    def test_shorts_views_positive(self) -> None:
        from mira.providers.analytics import pull

        stats = pull("chn_aitools", dry_run=True)
        assert stats["shorts_views_90d"] > 0


class TestYppProgress:
    def test_fractions_in_unit_interval(self) -> None:
        from mira.providers.analytics import pull, ypp_progress

        stats = pull("chn_aitools", dry_run=True)
        prog = ypp_progress(stats)

        for key in ("subs_1000", "watch_hours_4000", "shorts_views_10m"):
            assert 0.0 <= prog[key] <= 1.0, f"{key} out of [0,1]: {prog[key]}"

    def test_eligible_field_present(self) -> None:
        from mira.providers.analytics import pull, ypp_progress

        stats = pull("chn_aitools", dry_run=True)
        prog = ypp_progress(stats)
        assert "eligible" in prog
        assert isinstance(prog["eligible"], bool)

    def test_eligible_false_below_thresholds(self) -> None:
        from mira.providers.analytics import ypp_progress

        stats = {
            "subs": 100,
            "watch_hours": 200.0,
            "shorts_views_90d": 500_000,
        }
        prog = ypp_progress(stats)
        assert prog["eligible"] is False

    def test_eligible_true_via_watch_hours(self) -> None:
        from mira.providers.analytics import ypp_progress

        stats = {
            "subs": 1_000,
            "watch_hours": 4_000.0,
            "shorts_views_90d": 0,
        }
        prog = ypp_progress(stats)
        assert prog["subs_1000"] == 1.0
        assert prog["watch_hours_4000"] == 1.0
        assert prog["eligible"] is True

    def test_eligible_true_via_shorts(self) -> None:
        from mira.providers.analytics import ypp_progress

        stats = {
            "subs": 1_000,
            "watch_hours": 0.0,
            "shorts_views_90d": 10_000_000,
        }
        prog = ypp_progress(stats)
        assert prog["shorts_views_10m"] == 1.0
        assert prog["eligible"] is True

    def test_eligible_false_if_subs_missing(self) -> None:
        """Subs threshold not met even if watch_hours and shorts are OK."""
        from mira.providers.analytics import ypp_progress

        stats = {
            "subs": 500,
            "watch_hours": 4_000.0,
            "shorts_views_90d": 10_000_000,
        }
        prog = ypp_progress(stats)
        assert prog["eligible"] is False

    def test_fractions_clamped_at_one(self) -> None:
        from mira.providers.analytics import ypp_progress

        stats = {
            "subs": 999_999,
            "watch_hours": 999_999.0,
            "shorts_views_90d": 999_999_999,
        }
        prog = ypp_progress(stats)
        for key in ("subs_1000", "watch_hours_4000", "shorts_views_10m"):
            assert prog[key] == 1.0

    def test_none_values_treated_as_zero(self) -> None:
        from mira.providers.analytics import ypp_progress

        stats = {"subs": None, "watch_hours": None, "shorts_views_90d": None}
        prog = ypp_progress(stats)
        assert prog["eligible"] is False
        for key in ("subs_1000", "watch_hours_4000", "shorts_views_10m"):
            assert prog[key] == 0.0


class TestRpmEstimate:
    def test_us_heavy_higher_than_india_heavy(self) -> None:
        from mira.providers.analytics import rpm_estimate

        us_heavy = rpm_estimate({"US": 0.8, "IN": 0.1, "other": 0.1})
        in_heavy = rpm_estimate({"IN": 0.8, "US": 0.1, "other": 0.1})
        assert us_heavy > in_heavy

    def test_pure_us_equals_us_rpm(self) -> None:
        from mira.providers.analytics import rpm_estimate

        assert rpm_estimate({"US": 1.0}) == pytest.approx(4.2)

    def test_pure_ca_equals_ca_rpm(self) -> None:
        from mira.providers.analytics import rpm_estimate

        assert rpm_estimate({"CA": 1.0}) == pytest.approx(3.8)

    def test_pure_in_equals_in_rpm(self) -> None:
        from mira.providers.analytics import rpm_estimate

        assert rpm_estimate({"IN": 1.0}) == pytest.approx(0.65)

    def test_unknown_geo_falls_back_to_other(self) -> None:
        from mira.providers.analytics import rpm_estimate

        assert rpm_estimate({"XX": 1.0}) == pytest.approx(1.0)

    def test_blended_value_is_weighted_average(self) -> None:
        from mira.providers.analytics import rpm_estimate

        # 50 % US (4.2) + 50 % IN (0.65) = 2.425
        result = rpm_estimate({"US": 0.5, "IN": 0.5})
        assert result == pytest.approx((4.2 + 0.65) / 2, rel=1e-4)

    def test_shares_normalised(self) -> None:
        """Shares don't need to sum to 1 — they are normalised internally."""
        from mira.providers.analytics import rpm_estimate

        r_normalised = rpm_estimate({"US": 1.0, "IN": 1.0})
        r_fractions = rpm_estimate({"US": 0.5, "IN": 0.5})
        assert r_normalised == pytest.approx(r_fractions)

    def test_returns_float(self) -> None:
        from mira.providers.analytics import rpm_estimate

        assert isinstance(rpm_estimate({"US": 0.6, "CA": 0.2, "IN": 0.1, "other": 0.1}), float)
