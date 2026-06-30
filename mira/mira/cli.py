"""CLI for the mira command layer.

Stdlib-only: argparse + json. Two kinds of commands:
  • read fetches (status/channels/library/ideas/cost/support/engines/keys) → api.dispatch
  • actions (generate/schedule/publish/analytics/make-shorts) → call the real modules

``run(argv)`` returns the JSON-able result. ``main(argv)`` prints it.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any

from mira.api import dispatch

# Read commands map 1:1 to GET routes.
_DISPATCH: dict[str, str] = {
    "status": "/status", "channels": "/channels", "library": "/library",
    "ideas": "/ideas", "cost": "/cost", "support": "/support",
    "engines": "/engines", "keys": "/keys",
}


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _channel(cid: str) -> dict:
    from mira import fixtures
    c = fixtures.channel(cid)
    if c is None:
        raise SystemExit(f"unknown channel: {cid}")
    return c


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mira", description="Mira command layer")
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    for cmd in _DISPATCH:
        sub.add_parser(cmd, help=f"fetch {cmd}")

    g = sub.add_parser("generate", help="generate a video (offline-capable)")
    g.add_argument("--channel", default="chn_aitools")
    g.add_argument("--topic", required=True)
    g.add_argument("--target", type=int, default=None, help="target seconds")
    g.add_argument("--out-dir", default=None)
    g.add_argument("--visual", choices=["cards", "remotion", "hyperframes", "stock"],
                   default=None, help="visual engine (default: config.VISUAL_ENGINE / cards)")

    b = sub.add_parser("bench", help="render the same topic via Remotion (A) and HyperFrames (B) to compare")
    b.add_argument("--topic", required=True)
    b.add_argument("--channel", default="chn_aitools")
    b.add_argument("--target", type=int, default=None, help="target seconds")
    b.add_argument("--out-dir", default=None)
    b.add_argument("--size", default=None, help="WxH override, e.g. 1080x1920")

    sub.add_parser("schedule", help="dispatch plan for due videos")

    pub = sub.add_parser("publish", help="plan/publish a video (dry-run by default)")
    pub.add_argument("--video", required=True)
    pub.add_argument("--live", action="store_true", help="attempt real publish (needs OAuth)")

    an = sub.add_parser("analytics", help="pull channel analytics (dry-run by default)")
    an.add_argument("--channel", default="chn_aitools")

    ms = sub.add_parser("make-shorts", help="cut a long video into vertical shorts")
    ms.add_argument("--source", required=True)
    ms.add_argument("--out-dir", required=True)
    ms.add_argument("--clip-s", type=int, default=30)

    up = sub.add_parser("up", help="start the backend (serves dashboard API + supervises engines)")
    up.add_argument("--port", type=int, default=8770)
    up.add_argument("--no-supervise", action="store_true", help="don't auto-start local engines")

    sub.add_parser("engines-status", help="live status of local engines")
    es = sub.add_parser("engine-start", help="start a local engine")
    es.add_argument("--name", required=True)
    et = sub.add_parser("engine-stop", help="stop a local engine")
    et.add_argument("--name", required=True)
    return p


def run(argv: list[str]) -> Any:
    args = _build_parser().parse_args(argv)
    cmd = args.command
    if cmd is None:
        _build_parser().print_help()
        raise SystemExit(0)

    if cmd in _DISPATCH:
        _status, body = dispatch(_DISPATCH[cmd])
        return body

    if cmd == "generate":
        from mira import pipeline, config
        config.ensure_state_dir()
        out_dir = args.out_dir or str(config.STATE_DIR / "cli")
        topic = {"title": args.topic, "channel_id": args.channel, "source": "manual"}
        return pipeline.generate(
            _channel(args.channel), topic, out_dir,
            target_s=args.target, visual_engine=args.visual,
        )

    if cmd == "bench":
        from mira import pipeline, config
        config.ensure_state_dir()
        topic = {"title": args.topic, "channel_id": args.channel, "source": "manual"}
        size = None
        if args.size:
            try:
                w, h = args.size.lower().split("x")
                size = (int(w), int(h))
            except ValueError:
                raise SystemExit(f"--size must be WxH, e.g. 1080x1920 (got {args.size!r})")
        return pipeline.bench(
            _channel(args.channel), topic,
            out_dir=args.out_dir, target_s=args.target, size=size,
        )

    if cmd == "schedule":
        from mira import scheduler, fixtures
        return scheduler.dispatch_plan(fixtures.VIDEOS, fixtures.CHANNELS, _now())

    if cmd == "publish":
        from mira import fixtures
        from mira.providers import publish
        v = fixtures.video(args.video)
        if v is None:
            raise SystemExit(f"unknown video: {args.video}")
        return publish.publish(v, _channel(v["channel_id"]), dry_run=not args.live)

    if cmd == "analytics":
        from mira.providers import analytics
        return analytics.pull(args.channel, dry_run=True)

    if cmd == "make-shorts":
        from mira import clipfactory
        return clipfactory.make_shorts(args.source, args.out_dir, clip_s=args.clip_s)

    if cmd == "up":
        from mira import api
        api.serve(port=args.port, supervise=not args.no_supervise)
        return None  # blocks until Ctrl-C

    if cmd == "engines-status":
        from mira import engines
        return engines.status()

    if cmd == "engine-start":
        from mira import engines
        return engines.start(args.name)

    if cmd == "engine-stop":
        from mira import engines
        return engines.stop(args.name)

    raise SystemExit(f"unhandled command: {cmd}")


def main(argv: list[str] | None = None) -> None:
    result = run(argv if argv is not None else sys.argv[1:])
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
