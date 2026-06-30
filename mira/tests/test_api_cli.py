"""Phase-0 tests for mira api.py and cli.py.

All stdlib-only: pytest + urllib.request.  No fastapi, no requests.
"""
from __future__ import annotations

import socket
import threading
import time
import urllib.request
import json

import pytest

from mira.api import dispatch, serve
from mira import cli


# ── dispatch() unit tests ─────────────────────────────────────────────────────

def test_channels_returns_list_of_three():
    status, body = dispatch("/channels")
    assert status == 200
    assert isinstance(body, list)
    assert len(body) == 3


def test_status_has_to_review_key():
    status, body = dispatch("/status")
    assert status == 200
    assert "to_review" in body


def test_unknown_path_returns_404_with_error():
    status, body = dispatch("/nope")
    assert status == 404
    assert isinstance(body, dict)
    assert "error" in body


def test_support_providers_llm_includes_groq_and_mistral():
    status, body = dispatch("/support")
    assert status == 200
    llm_providers = body["providers"]["llm"]
    assert "groq" in llm_providers
    assert "mistral" in llm_providers


def test_library_returns_list():
    status, body = dispatch("/library")
    assert status == 200
    assert isinstance(body, list)


def test_ideas_returns_list():
    status, body = dispatch("/ideas")
    assert status == 200
    assert isinstance(body, list)


def test_cost_returns_dict_with_spend():
    status, body = dispatch("/cost")
    assert status == 200
    assert "spend_mtd" in body


# ── cli.run() tests ───────────────────────────────────────────────────────────

def test_cli_run_channels_returns_three_channel_list():
    result = cli.run(["channels"])
    assert isinstance(result, list)
    assert len(result) == 3


def test_cli_run_support_returns_dict_with_machine():
    result = cli.run(["support"])
    assert isinstance(result, dict)
    assert "machine" in result


def test_cli_run_status_returns_dict_with_to_review():
    result = cli.run(["status"])
    assert isinstance(result, dict)
    assert "to_review" in result


# ── Live server smoke test ────────────────────────────────────────────────────

def _free_port() -> int:
    """Bind to port 0 and return the OS-assigned port number."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_live_server_get_status():
    port = _free_port()

    # Start serve() in a daemon thread so it dies with the test process.
    t = threading.Thread(target=serve, args=(port,), daemon=True)
    t.start()

    # Wait for the server to accept connections (up to 3 s).
    deadline = time.monotonic() + 3.0
    connected = False
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                connected = True
                break
        except OSError:
            time.sleep(0.05)

    assert connected, f"Server did not start on port {port} within 3 s"

    url = f"http://127.0.0.1:{port}/status"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        content_type = resp.headers.get("Content-Type", "")
        assert "application/json" in content_type
        body = json.loads(resp.read())

    assert "to_review" in body
