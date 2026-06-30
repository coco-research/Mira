"""Consolidation tests: new CLI action commands + hardened api routes."""
from mira import cli
from mira import api


def test_engines_and_keys_fetch():
    menus = cli.run(["engines"])
    assert isinstance(menus, list) and len(menus) == 11
    assert any(m["stage"] == "script" for m in menus)
    conf = cli.run(["keys"])
    assert isinstance(conf, dict) and all(isinstance(v, bool) for v in conf.values())


def test_schedule_returns_plan_list():
    plan = cli.run(["schedule"])
    assert isinstance(plan, list)


def test_analytics_dry_run():
    stats = cli.run(["analytics", "--channel", "chn_aitools"])
    assert isinstance(stats, dict)
    assert "subs" in stats or "views_28d" in stats


def test_publish_is_safe_by_default():
    plan = cli.run(["publish", "--video", "vid_a1b2"])
    assert isinstance(plan, dict)
    assert plan.get("disclosure") is True
    assert plan.get("action") in {"dry_run", "hold", "publish"}


def test_api_routes_are_deep_copied():
    _, a = api.dispatch("/channels")
    a[0]["name"] = "MUTATED"
    _, b = api.dispatch("/channels")
    assert b[0]["name"] != "MUTATED"   # fixture not corrupted


def test_new_routes_present():
    code, menus = api.dispatch("/engines")
    assert code == 200 and isinstance(menus, list)
    code2, conf = api.dispatch("/keys")
    assert code2 == 200 and isinstance(conf, dict)
    code3, vids = api.dispatch("/videos")
    assert code3 == 200 and isinstance(vids, list)
