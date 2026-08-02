"""Phase② 角色注册表 API 验证"""
import json, urllib.request

BASE = "http://localhost:3100"
PROJECT = "e93a57a1-fe76-4c08-820a-6c9735b83c3d"

def req(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        r.add_header("content-type", "application/json")
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))

# 1. 全局角色表：6 个 Hub 工作角色 + 2 个系统角色 + 1 个中枢
roles = req("GET", "/agent-roles")
print("agent-roles:", [(r["name"], r["builtin"]) for r in roles])
taxonomy = {r["name"]: r["kind"] for r in roles if r["builtin"]}
assert taxonomy == {
    "explore": "role", "analyze": "role", "review": "role",
    "test": "role", "code": "role", "audit": "role",
    "verify": "system", "report": "system", "hub_reason": "hub",
}, taxonomy

global_configs = req("GET", "/role-configs/global")
assert {c["role_name"] for c in global_configs} == set(taxonomy), global_configs
assert all(len((c.get("instructions_markdown") or "").strip()) >= 200 for c in global_configs), global_configs
assert all("### 长期职责" in (c.get("instructions_markdown") or "") for c in global_configs), global_configs
assert all("?" not in (c.get("instructions_markdown") or "") for c in global_configs), global_configs

# 2. 项目视角：默认全部内置启用
proles = req("GET", f"/projects/{PROJECT}/roles")
print("默认启用:", [(r["name"], r["enabled"], r["default_enabled"]) for r in proles])
assert {r["name"] for r in proles} == {"explore", "analyze", "review", "test", "code", "audit"}

# 3. 项目只勾选 explore + analyze
req("PATCH", f"/projects/{PROJECT}/settings", {"roles": {"enabled": ["explore", "analyze"]}})
proles = req("GET", f"/projects/{PROJECT}/roles")
print("勾选后:", [(r["name"], r["enabled"]) for r in proles])

# 4. 新建自定义角色
custom = req("POST", "/agent-roles", {
    "name": "threat_model",
    "title": "威胁建模",
    "description": "对攻击面做威胁建模，产出威胁清单事实",
})
print("新建角色:", custom["name"], custom["builtin"])

# 5. 项目启用自定义角色（显式清单含自定义）
req("PATCH", f"/projects/{PROJECT}/settings", {"roles": {"enabled": ["explore", "threat_model"]}})
proles = req("GET", f"/projects/{PROJECT}/roles")
print("含自定义:", [(r["name"], r["enabled"]) for r in proles])

# 6. 角色运行配置直接写 RoleConfig
cfg = req("PUT", f"/projects/{PROJECT}/role-configs/{custom['id']}", {
    "agent_cli": "claude-code", "model": None, "reasoning": None,
    "env_keys": [], "env_vars": {}, "modules": [], "skills": [], "commands": [],
    "mcps": [], "subagents": [], "instructions_markdown": "输出必须包含威胁与证据的对应关系。",
    "runtime_image_key": None, "credentials": [], "config_files": [],
})
print("RoleConfig 已保存:", cfg["role_id"] == custom["id"])

# 7. 内置角色不可删
try:
    explore_id = next(r["id"] for r in roles if r["name"] == "explore")
    req("DELETE", f"/agent-roles/{explore_id}")
    print("!! 内置角色被删了（不应发生）")
except urllib.error.HTTPError as e:
    print("内置删除被拒:", e.code)

# 8. 删除项目 RoleConfig，恢复默认角色并删自定义角色
req("DELETE", f"/projects/{PROJECT}/role-configs/{custom['id']}")
req("PATCH", f"/projects/{PROJECT}/settings", {"roles": {"enabled": None}})
req("DELETE", f"/agent-roles/{custom['id']}")
proles = req("GET", f"/projects/{PROJECT}/roles")
print("恢复默认:", [(r["name"], r["enabled"], r["default_enabled"]) for r in proles])
print("OK")
