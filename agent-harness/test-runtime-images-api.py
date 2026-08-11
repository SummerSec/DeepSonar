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


def assert_frozen_runtime(snapshot: dict, image_key: str) -> None:
    """Job must freeze an immutable runtime, regardless of fake/real catalog source."""
    assert snapshot["image_key"] == image_key, snapshot
    assert snapshot["image_digest"].startswith("sha256:"), snapshot
    assert snapshot["image_ref"].endswith("@" + snapshot["image_digest"]), snapshot


def main() -> None:
    suffix = uuid.uuid4().hex[:8]
    project = req("POST", "/projects", {"name": f"images-ci-{suffix}"}, 201)
    project_id = project["id"]

    market = req("GET", "/runtime-images")
    by_key = {image["image_key"]: image for image in market}
    official_keys = ("deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal")
    chrome_keys = ("deepsonar-chrome-audit", "deepsonar-chrome-test", "deepsonar-chrome-fuzz")
    assert set(official_keys).issubset(by_key), by_key.keys()
    assert set(chrome_keys).issubset(by_key), by_key.keys()
    assert by_key["deepsonar-base"]["description"] == "Explore、Analyze、Code、Hub 与 Verify 的官方最小运行时"
    assert by_key["deepsonar-audit"]["description"] == "Audit 的官方审计运行时"
    assert by_key["deepsonar-kali-minimal"]["description"] == "Test 默认使用的精简 Kali 多语言工具链；不安装 Kali metapackage 或 GUI"
    assert all(by_key[key]["official"] for key in official_keys)
    assert all(by_key[key]["official"] and by_key[key]["project_opt_in"] for key in chrome_keys)
    assert not by_key["deepsonar-base"]["project_opt_in"]
    assert not by_key["deepsonar-audit"]["project_opt_in"]
    assert not by_key["deepsonar-kali-minimal"]["project_opt_in"]

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

    # 项目镜像绑定必须经过项目镜像策略；隔离中的第三方镜像即使通过新接口也不能使用。
    req(
        "PATCH",
        f"/projects/{project_id}/settings",
        {
            "image_strategy": "project_managed",
            "role_runtime_images": {"verify": imported["image"]["image_key"]},
        },
        400,
    )

    role_configs = req("GET", "/role-configs/global")
    explore = next(item for item in role_configs if item["role_name"] == "explore")
    test_role = next(item for item in role_configs if item["role_name"] == "test")
    verify_role = next(item for item in role_configs if item["role_name"] == "verify")
    assert explore["runtime_image_key"] is None, explore
    assert test_role["runtime_image_key"] == "deepsonar-kali-minimal", test_role
    assert verify_role["runtime_image_key"] is None, verify_role
    # 项目 RoleConfig 的旧镜像字段必须继续拒绝，防止绕过项目镜像策略。
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
    assert job["agent_snapshot_json"]["runtime_image_key"] is None, job["agent_snapshot_json"]
    assert_frozen_runtime(snapshot, "deepsonar-base")

    test_job = req(
        "POST",
        "/jobs",
        {"project_id": project_id, "type": "test", "title": "Kali test runtime default smoke"},
        201,
    )
    test_snapshot = test_job["agent_snapshot_json"]["runtime_image"]
    assert_frozen_runtime(test_snapshot, "deepsonar-kali-minimal")

    verify_job = req(
        "POST",
        "/jobs",
        {"project_id": project_id, "type": "verify", "title": "Base verify runtime default smoke"},
        201,
    )
    verify_snapshot = verify_job["agent_snapshot_json"]["runtime_image"]
    assert verify_job["agent_snapshot_json"]["runtime_image_key"] is None, verify_job["agent_snapshot_json"]
    assert_frozen_runtime(verify_snapshot, "deepsonar-base")

    # Verify 全局仍使用 Base，但项目可通过镜像策略显式选择与 Test 相同的可信动态运行时。
    # 覆盖只应反映在本项目新 Job 中，不能修改全局 RoleConfig。
    req(
        "PATCH",
        f"/projects/{project_id}/settings",
        {
            "image_strategy": "project_managed",
            "role_runtime_images": {"verify": "deepsonar-kali-minimal"},
        },
        200,
    )
    project_settings = req("GET", f"/projects/{project_id}/settings")
    assert project_settings["image_strategy"] == "project_managed", project_settings
    assert project_settings["role_runtime_images"] == {"verify": "deepsonar-kali-minimal"}, project_settings
    global_verify = next(item for item in req("GET", "/role-configs/global") if item["role_name"] == "verify")
    assert global_verify["runtime_image_key"] is None, global_verify
    dynamic_verify_job = req(
        "POST",
        "/jobs",
        {"project_id": project_id, "type": "verify", "title": "explicit dynamic verify runtime smoke"},
        201,
    )
    dynamic_verify_snapshot = dynamic_verify_job["agent_snapshot_json"]["runtime_image"]
    assert dynamic_verify_job["agent_snapshot_json"]["runtime_image_key"] == "deepsonar-kali-minimal", dynamic_verify_job["agent_snapshot_json"]
    assert_frozen_runtime(dynamic_verify_snapshot, "deepsonar-kali-minimal")
    assert "Runtime test toolchain" in (dynamic_verify_job["agent_snapshot_json"].get("instructions_markdown") or "")
    req("PATCH", f"/projects/{project_id}/settings", {"image_strategy": "inherit_global"}, 200)

    usage = req("GET", f"/runtime-image-versions/{version_id}/usage")
    assert usage == {"version_id": version_id, "projects": [], "jobs": [], "findings": []}
    req("POST", f"/runtime-image-versions/{version_id}/status", {"status": "rejected", "reason": "CI cleanup"})
    req("POST", f"/projects/{project_id}/archive")
    print("OK: standalone market, specialist image opt-in, system sandbox default, quarantine gate, project binding gate, immutable Job snapshot")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
