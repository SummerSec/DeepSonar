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

# 1. 全局角色表：5 内置
roles = req("GET", "/agent-roles")
print("agent-roles:", [(r["name"], r["builtin"]) for r in roles])

# 2. 项目视角：默认全部内置启用
proles = req("GET", f"/projects/{PROJECT}/roles")
print("默认启用:", [(r["name"], r["enabled"], r["default_enabled"]) for r in proles])

# 3. 项目只勾选 explore + analyze
req("PATCH", f"/projects/{PROJECT}/settings", {"roles": {"enabled": ["explore", "analyze"]}})
proles = req("GET", f"/projects/{PROJECT}/roles")
print("勾选后:", [(r["name"], r["enabled"]) for r in proles])

# 4. 新建自定义角色
custom = req("POST", "/agent-roles", {
    "name": "threat_model",
    "title": "威胁建模",
    "description": "对攻击面做威胁建模，产出威胁清单事实",
    "prompt_template": "你是威胁建模 agent。代码在 /workspace/src。\n\n当前意图：{{intent}}\n\n画布：\n{{graph}}\n\n写 /workspace/fact.json：{\"title\":\"...\",\"description\":\"...\"}（纯 JSON）",
})
print("新建角色:", custom["name"], custom["builtin"])

# 5. 项目启用自定义角色（显式清单含自定义）
req("PATCH", f"/projects/{PROJECT}/settings", {"roles": {"enabled": ["explore", "threat_model"]}})
proles = req("GET", f"/projects/{PROJECT}/roles")
print("含自定义:", [(r["name"], r["enabled"]) for r in proles])

# 6. 角色绑定 profile（audit-kimi-ponytail）
profiles = req("GET", "/agent-profiles")
pid = next((p["id"] for p in profiles if p["name"] == "audit-kimi-ponytail"), None)
if pid:
    req("PATCH", f"/projects/{PROJECT}/settings", {"profiles": {"threat_model": pid, "hub_reason": pid}})
    proles = req("GET", f"/projects/{PROJECT}/roles")
    tm = next(r for r in proles if r["name"] == "threat_model")
    print("threat_model 绑定 profile:", tm["profile_id"] == pid)

# 7. 内置角色不可删
try:
    explore_id = next(r["id"] for r in roles if r["name"] == "explore")
    req("DELETE", f"/agent-roles/{explore_id}")
    print("!! 内置角色被删了（不应发生）")
except urllib.error.HTTPError as e:
    print("内置删除被拒:", e.code)

# 8. 恢复默认（null）+ 删自定义角色
req("PATCH", f"/projects/{PROJECT}/settings", {"roles": {"enabled": None}, "profiles": {"threat_model": None, "hub_reason": None}})
req("DELETE", f"/agent-roles/{custom['id']}")
proles = req("GET", f"/projects/{PROJECT}/roles")
print("恢复默认:", [(r["name"], r["enabled"], r["default_enabled"]) for r in proles])
print("OK")
