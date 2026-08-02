# -*- coding: utf-8 -*-
"""Runtime image marketplace and immutable Job snapshot API smoke (fake mode)."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("DEEPSONAR_BASE", "http://127.0.0.1:3100").rstrip("/")


def req(method: str, path: str, body=None, expect: int = 200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            code = response.status
            payload = json.loads(response.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as error:
        code = error.code
        payload = json.loads(error.read().decode("utf-8") or "{}")
    assert code == expect, f"{method} {path} -> {code} (expected {expect}): {payload}"
    return payload


def main() -> None:
    suffix = uuid.uuid4().hex[:8]
    project = req("POST", "/projects", {"name": f"images-ci-{suffix}"}, 201)
    project_id = project["id"]

    market = req("GET", "/runtime-images")
    by_key = {image["image_key"]: image for image in market}
    official_keys = ("deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal")
    assert set(official_keys).issubset(by_key), by_key.keys()
    assert all(by_key[key]["official"] for key in official_keys)
    assert not by_key["deepsonar-base"]["project_opt_in"]
    assert not by_key["deepsonar-audit"]["project_opt_in"]
    assert by_key["deepsonar-kali-minimal"]["project_opt_in"]

    req(
        "POST",
        "/runtime-images/import",
        {
            "image_key": f"blocked-{suffix}",
            "name": "Blocked registry",
            "publisher": "CI",
            "image_ref": "untrusted.example/ci/runtime:1",
        },
        400,
    )

    imported = req(
        "POST",
        "/runtime-images/import",
        {
            "image_key": f"ci-runtime-{suffix}",
            "name": "CI quarantined runtime",
            "description": "admission API smoke",
            "publisher": "CI",
            "source_url": "https://github.com/example/runtime",
            "image_ref": f"ghcr.io/example/deepsonar-ci:{suffix}",
            "version": suffix,
        },
        202,
    )
    image_id = imported["image"]["id"]
    version_id = imported["version"]["id"]
    assert imported["version"]["trust_status"] == "quarantined"
    assert imported["scan"]["status"] == "queued"

    detail = req("GET", f"/runtime-images/{image_id}")
    assert detail["versions"][0]["id"] == version_id
    assert detail["versions"][0]["scans"][0]["status"] == "queued"
    req("POST", f"/runtime-image-versions/{version_id}/status", {"status": "trusted"}, 409)
    req("PUT", f"/projects/{project_id}/runtime-images/{image_id}", {"enabled": True}, 409)

    filtered = req(
        "GET",
        "/runtime-images?" + urllib.parse.urlencode({"project_id": project_id, "search": suffix}),
    )
    assert len(filtered) == 1 and filtered[0]["id"] == image_id

    role_configs = req("GET", "/role-configs/global")
    explore = next(item for item in role_configs if item["role_name"] == "explore")
    invalid = {
        "agent_cli": explore["agent_cli"],
        "model": explore["model"],
        "reasoning": explore["reasoning"],
        "env_keys": explore["env_keys"],
        "env_vars": explore["env_vars_json"],
        "modules": explore["modules_json"],
        "skills": explore["skills_json"],
        "commands": explore["commands_json"],
        "mcps": explore["mcps_json"],
        "subagents": explore["subagents_json"],
        "platform_tools": explore["platform_tools_json"],
        "instructions_markdown": explore["instructions_markdown"],
        "runtime_image_key": imported["image"]["image_key"],
        "credentials": [],
        "config_files": explore["config_files"],
    }
    req("PUT", f"/projects/{project_id}/role-configs/{explore['role_id']}", invalid, 400)

    job = req(
        "POST",
        "/jobs",
        {"project_id": project_id, "type": "explore", "title": "runtime snapshot smoke"},
        201,
    )
    snapshot = job["agent_snapshot_json"]["runtime_image"]
    assert snapshot["image_key"] == "deepsonar-base", snapshot
    assert snapshot["image_ref"].startswith("fake://deepsonar-base@sha256:"), snapshot
    assert snapshot["image_digest"].startswith("sha256:"), snapshot

    usage = req("GET", f"/runtime-image-versions/{version_id}/usage")
    assert usage == {"version_id": version_id, "projects": [], "jobs": [], "findings": []}
    req("POST", f"/runtime-image-versions/{version_id}/status", {"status": "rejected", "reason": "CI cleanup"})
    req("POST", f"/projects/{project_id}/archive")
    print("OK: standalone market, quarantine gate, project binding gate, immutable Job snapshot")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
