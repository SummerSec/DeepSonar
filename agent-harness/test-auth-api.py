# -*- coding: utf-8 -*-
"""AUTH 工作包验收（SEC-01/§6.1）：平台 API Token 鉴权
需要一个 DEEPSONAR_AUTH_REQUIRED=true + DEEPSONAR_ADMIN_TOKEN 的实例（默认 3101 端口）：
  DEEPSONAR_AUTH_REQUIRED=true DEEPSONAR_ADMIN_TOKEN=boot-secret SCHEDULER_PORT=3101 pnpm --filter @deepsonar/scheduler dev
"""
import json
import urllib.request
import uuid

BASE = "http://localhost:3101"
ADMIN = "boot-secret"


def req(method, path, body=None, token=None, expect=200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    if token:
        headers["authorization"] = f"Bearer {token}"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            code, payload = resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        code, payload = e.code, json.loads(e.read().decode("utf-8") or "{}")
    assert code == expect, f"{method} {path} -> {code}（期望 {expect}）: {payload}"
    return payload


def main():
    # 1. 豁免路由：/health 无需 token
    req("GET", "/health")
    print("health 豁免 OK")

    # 2. 无 token / 坏 token → 401
    req("GET", "/projects", expect=401)
    req("GET", "/projects", token="deepsonar_dev_00000000_wrongsecret123456", expect=401)
    req("GET", "/projects", token="not-a-token", expect=401)
    print("未认证 401 OK")

    # 3. 引导管理员：全 scope
    projects = req("GET", "/projects", token=ADMIN)
    print("引导管理员 OK，项目数:", len(projects))

    # 4. 创建受限 token（tasks:read），明文只返回一次
    t = req("POST", "/tokens", {"name": f"ci-{uuid.uuid4().hex[:6]}", "scopes": ["tasks:read"]}, ADMIN, 201)
    plaintext = t["token"]
    assert plaintext.startswith("deepsonar_dev_") and t["token_prefix"] in plaintext
    tid = t["id"]
    # 列表不回明显文/哈希
    lst = req("GET", "/tokens", token=ADMIN)
    row = next(x for x in lst if x["id"] == tid)
    assert "token" not in row and "token_hash" not in row
    print("创建 OK（列表无明文/哈希）:", plaintext[:20] + "…")

    # 5. scope 判定：tasks:read 可读 jobs，不能写项目/管理 token
    req("GET", "/jobs", token=plaintext)
    req("POST", "/projects", {"name": "x"}, plaintext, 403)
    req("GET", "/tokens", token=plaintext, expect=403)
    req("POST", "/jobs/" + uuid.uuid4().hex + "/cancel", None, plaintext, 403)  # jobs:control 未授予
    print("scope 判定 OK（读放行/写 403）")

    # 6. 项目限定 token：访问其他项目 403
    if projects:
        pid = projects[0]["id"]
        pt = req("POST", "/tokens", {"name": "proj-only", "scopes": ["projects:read", "admin"], "project_id": pid}, ADMIN, 201)
        req("GET", f"/projects/{pid}", token=pt["token"])
        others = [p["id"] for p in projects if p["id"] != pid]
        if others:
            req("GET", f"/projects/{others[0]}", token=pt["token"], expect=403)
        req("POST", f"/tokens/{pt['id']}/revoke", None, ADMIN)
        print("项目限定 OK")

    # 7. 吊销 → 立即 401
    req("POST", f"/tokens/{tid}/revoke", None, ADMIN)
    req("GET", "/jobs", token=plaintext, expect=401)
    print("吊销 OK")

    # 8. 轮换：新 token 可用、旧 token 立即失效
    t2 = req("POST", "/tokens", {"name": "rot", "scopes": ["tasks:read"]}, ADMIN, 201)
    t3 = req("POST", f"/tokens/{t2['id']}/rotate", None, ADMIN, 201)
    assert t3["rotated_from"] == t2["id"] and t3["token"] != t2["token"]
    req("GET", "/jobs", token=t3["token"])
    req("GET", "/jobs", token=t2["token"], expect=401)
    req("POST", f"/tokens/{t3['id']}/revoke", None, ADMIN)
    print("轮换 OK")

    # 9. 过期 token → 401（直接改库过期时间）
    t4 = req("POST", "/tokens", {"name": "exp", "scopes": ["tasks:read"], "expires_in_days": 1}, ADMIN, 201)
    import subprocess
    subprocess.run(["docker", "exec", "deepsonar-postgres", "psql", "-U", "deepsonar", "-d", "deepsonar", "-c",
                    f"UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = '{t4['id']}';"],
                   check=True, capture_output=True)
    req("GET", "/jobs", token=t4["token"], expect=401)
    req("POST", f"/tokens/{t4['id']}/revoke", None, ADMIN)
    print("过期判定 OK")

    print("OK")


if __name__ == "__main__":
    main()
