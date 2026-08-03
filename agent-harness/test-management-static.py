"""Non-live smoke for the management CLI's read-only pagination commands."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "deepsonar-management" / "scripts" / "deepsonar-api.py"
spec = importlib.util.spec_from_file_location("deepsonar_management", SCRIPT)
assert spec and spec.loader
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

calls = []


def fake_call(method, path, body=None):
    calls.append((method, path, body))
    return {"items": [], "next_cursor": None, "has_more": False}


cli.call = fake_call

cli._jobs_list([], {"project": "p/1", "status": "running", "after": "opaque cursor", "limit": "25"})
method, path, body = calls.pop()
assert method == "GET" and body is None
query = parse_qs(urlsplit(path).query)
assert query == {"project_id": ["p/1"], "status": ["running"], "after": ["opaque cursor"], "limit": ["25"]}, query

cli._jobs_broadcasts(["job-1"], {"after": "cursor", "status": "failed,unknown", "limit": "2"})
method, path, body = calls.pop()
assert method == "GET" and path.startswith("/jobs/job-1/broadcasts") and body is None
query = parse_qs(urlsplit(path).query)
assert query == {"after": ["cursor"], "status": ["failed,unknown"], "limit": ["2"]}, query

cli._canvases_broadcasts(["canvas-1"], {"status": "injected", "limit": "100"})
method, path, body = calls.pop()
assert method == "GET" and path.startswith("/canvases/canvas-1/broadcasts") and body is None
assert parse_qs(urlsplit(path).query) == {"limit": ["100"], "status": ["injected"]}

try:
    cli._jobs_broadcasts(["job-1"], {"limit": "101"})
except cli.ApiError:
    pass
else:
    raise AssertionError("limit > 100 must fail before any network call")

parsed = cli._decode_json_text("\ufeff{\"items\":[],\"next_cursor\":null,\"has_more\":false}")
assert parsed == {"items": [], "next_cursor": None, "has_more": False}

print('{"ok":true,"smoke":"management-static"}')
