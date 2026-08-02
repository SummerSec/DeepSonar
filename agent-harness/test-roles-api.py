# -*- coding: utf-8 -*-
"""Phase② 角色注册表 API 验证（自举项目，可 CI）。"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("DEEPSONAR_BASE", "http://127.0.0.1:3100").rstrip("/")


def req(method: str, path: str, body=None, expect: int | None = 200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            code, payload = resp.status, json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            payload = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            payload = {}
    if expect is None:
        return code, payload
    if code != expect:
        raise AssertionError(f"{method} {path} -> {code}（期望 {expect}）: {payload}")
    return payload


def main() -> None:
    tag = uuid.uuid4().hex[:6]
    project = req("POST", "/projects", {"name": f"roles-ci-{tag}", "description": "roles api smoke"}, 201)
    pid = project["id"]
    print("project:", pid)

    # 1. 全局角色表：6 个 Hub 工作角色 + 2 个系统角色 + 1 个中枢
    roles = req("GET", "/agent-roles")
    print("agent-roles:", [(r["name"], r["builtin"]) for r in roles])
    taxonomy = {r["name"]: r["kind"] for r in roles if r["builtin"]}
    assert taxonomy == {
        "explore": "role",
        "analyze": "role",
        "review": "role",
        "test": "role",
        "code": "role",
        "audit": "role",
        "verify": "system",
        "report": "system",
        "hub_reason": "hub",
    }, taxonomy

    global_configs = req("GET", "/role-configs/global")
    assert {c["role_name"] for c in global_configs} == set(taxonomy), global_configs
    assert all(len((c.get("instructions_markdown") or "").strip()) >= 200 for c in global_configs), global_configs
    assert all("### 长期职责" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
    assert all("### 平台工具使用" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
    assert all("emit_progress" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
    assert all("mark_job_done" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
    assert all("request_human" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
    assert all("accepted event" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
    assert all(c.get("platform_tools_json") == {} for c in global_configs), global_configs
    by_role = {c["role_name"]: c.get("instructions_markdown") or "" for c in global_configs}
    for role in ("explore", "analyze", "review", "test", "code"):
        assert "emit_fact" in by_role[role], role
    assert "emit_finding" in by_role["audit"]
    assert "list_available_roles" in by_role["hub_reason"]
    assert "submit_hub_decision" in by_role["hub_reason"]
    assert "confirmed|false_positive|needs_human" in by_role["verify"]
    hub_cfg = next(c for c in global_configs if c["role_name"] == "hub_reason")
    code, _ = req(
        "PUT",
        f"/role-configs/global/{hub_cfg['role_id']}",
        {"platform_tools": {"list_available_roles": False}},
        expect=None,
    )
    assert code == 400, f"关闭 Hub 角色查询工具应被拒，得到 {code}"

    # 2. 项目视角：默认全部内置工作角色启用（库中可能残留历史自定义角色，不纳入集合相等）
    proles = req("GET", f"/projects/{pid}/roles")
    print("默认启用:", [(r["name"], r["enabled"], r["default_enabled"]) for r in proles])
    builtin_work = {"explore", "analyze", "review", "test", "code", "audit"}
    by_name = {r["name"]: r for r in proles}
    assert builtin_work.issubset(by_name.keys()), by_name.keys()
    assert all(by_name[n]["enabled"] and by_name[n]["default_enabled"] for n in builtin_work), by_name

    # 3. 项目只勾选 explore + analyze
    req("PATCH", f"/projects/{pid}/settings", {"roles": {"enabled": ["explore", "analyze"]}})
    proles = req("GET", f"/projects/{pid}/roles")
    enabled = {r["name"] for r in proles if r["enabled"]}
    assert enabled == {"explore", "analyze"}, enabled
    print("勾选后:", [(r["name"], r["enabled"]) for r in proles])

    # 4. 新建自定义角色
    code, custom = req(
        "POST",
        "/agent-roles",
        {
            "name": f"threat_model_{tag}",
            "title": "威胁建模",
            "description": "对攻击面做威胁建模，产出威胁清单事实",
        },
        expect=None,
    )
    assert code in (200, 201), code
    print("新建角色:", custom["name"], custom["builtin"])

    # 5. 项目启用自定义角色
    req(
        "PATCH",
        f"/projects/{pid}/settings",
        {"roles": {"enabled": ["explore", custom["name"]]}},
    )
    proles = req("GET", f"/projects/{pid}/roles")
    enabled = {r["name"] for r in proles if r["enabled"]}
    assert custom["name"] in enabled and "explore" in enabled, enabled
    print("含自定义:", [(r["name"], r["enabled"]) for r in proles if r["enabled"]])

    # 6. 角色运行配置直接写 RoleConfig
    config_body = {
        "agent_cli": "claude-code",
        "model": None,
        "reasoning": None,
        "env_keys": [],
        "env_vars": {},
        "modules": [],
        "skills": [],
        "commands": [],
        "mcps": [],
        "subagents": [],
        "platform_tools": {
            "emit_progress": False,
            "emit_fact": True,
            "mark_job_done": True,
            "request_human": False,
        },
        "instructions_markdown": "输出必须包含威胁与证据的对应关系。",
        "runtime_image_key": None,
        "credentials": [],
        "config_files": [],
    }
    cfg = req(
        "PUT",
        f"/projects/{pid}/role-configs/{custom['id']}",
        config_body,
    )
    assert cfg["role_id"] == custom["id"]
    assert cfg["platform_tools_json"] == config_body["platform_tools"]
    project_configs = req("GET", f"/projects/{pid}/role-configs")
    custom_entry = next(c for c in project_configs if c["role_id"] == custom["id"])
    assert custom_entry["project_config"]["platform_tools_json"] == config_body["platform_tools"]
    invalid_body = {**config_body, "platform_tools": {**config_body["platform_tools"], "mark_job_done": False}}
    code, _ = req("PUT", f"/projects/{pid}/role-configs/{custom['id']}", invalid_body, expect=None)
    assert code == 400, f"关闭终态工具应被拒，得到 {code}"
    print("RoleConfig 平台工具开关已保存，终态工具不可关闭:", code)

    # 7. 系统角色可修改职责但不可删除；kind=role 的角色（包括内置模板）走统一可删除策略
    verify = next(r for r in roles if r["name"] == "verify")
    original_verify_description = verify["description"]
    marker = f"{original_verify_description} [smoke-{tag}]"
    updated_verify = req("PATCH", f"/agent-roles/{verify['id']}", {"description": marker})
    assert updated_verify["description"] == marker
    req("PATCH", f"/agent-roles/{verify['id']}", {"description": original_verify_description})
    code, _ = req("DELETE", f"/agent-roles/{verify['id']}", expect=None)
    assert code == 409, f"系统角色删除应被拒，得到 {code}"
    print("系统角色可修改但不可删除:", code)

    # 8. 清理
    req("DELETE", f"/projects/{pid}/role-configs/{custom['id']}")
    req("PATCH", f"/projects/{pid}/settings", {"roles": {"enabled": None}})
    # Hub 可下发的 kind=role 均可删除；自定义角色在这里验证并清理。
    req("DELETE", f"/agent-roles/{custom['id']}")
    req("POST", f"/projects/{pid}/archive", None)
    print("OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)
