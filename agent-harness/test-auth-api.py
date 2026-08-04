# -*- coding: utf-8 -*-
"""AUTH 工作包验收（SEC-01/§6.1）：平台 API Token 鉴权（可 CI）。

需要 DEEPSONAR_AUTH_REQUIRED=true + DEEPSONAR_ADMIN_TOKEN 的实例：
  DEEPSONAR_AUTH_REQUIRED=true DEEPSONAR_ADMIN_TOKEN=boot-secret SCHEDULER_PORT=3101 \\
    node apps/scheduler/dist/index.js
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("DEEPSONAR_BASE", "http://127.0.0.1:3101").rstrip("/")
ADMIN = os.environ.get("DEEPSONAR_ADMIN_TOKEN", "boot-secret")
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://deepsonar:deepsonar@127.0.0.1:5432/deepsonar",
)


def req(method: str, path: str, body=None, token=None, expect: int = 200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    if token:
        headers["authorization"] = f"Bearer {token}"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            code, payload = resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            payload = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            payload = {}
    assert code == expect, f"{method} {path} -> {code}（期望 {expect}）: {payload}"
    return payload


def expire_token(token_id: str) -> bool:
    """把 token 标为已过期。优先 psql(DATABASE_URL)，否则尝试 docker 容器。"""
    sql = f"UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = '{token_id}' RETURNING id;"
    if shutil.which("psql"):
        r = subprocess.run(
            ["psql", DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0 and token_id in r.stdout:
            return True
        print("psql expire 失败:", r.stderr.strip(), file=sys.stderr)

    if shutil.which("docker"):
        configured = os.environ.get("DEEPSONAR_TEST_POSTGRES_CONTAINER")
        candidates = []
        if configured:
            candidates.append((configured, "deepsonar", "deepsonar"))
        candidates.extend((
            ("deepsonar-postgres", "deepsonar", "deepsonar"),
            ("dfh-postgres", "deepsonar", "deepsonar"),
            ("dfh-postgres", "dfh", "deepflowhunter"),
        ))
        for container, user, db in candidates:
            r = subprocess.run(
                ["docker", "exec", container, "psql", "-U", user, "-d", db, "-c", sql],
                capture_output=True,
                text=True,
            )
            if r.returncode == 0 and token_id in r.stdout:
                return True
    return False


def main() -> None:
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

    # 4. First-run human account: the scheduler seeds this only when users is empty.
    status = req("GET", "/auth/status")
    assert status["has_users"] and not status["bootstrap_available"], status
    human = req("POST", "/auth/login", {"username": "admin", "password": "Deep@Sonar66"})
    human_token = human["token"]
    changed_password = f"{uuid.uuid4().hex}A!"
    changed_username = f"admin-ci-{uuid.uuid4().hex[:8]}"
    changed = req(
        "POST",
        "/auth/change-password",
        {"current_password": "Deep@Sonar66", "new_password": changed_password},
        human_token,
    )
    req("GET", "/auth/me", token=human_token, expect=401)
    req("POST", "/auth/login", {"username": "admin", "password": "Deep@Sonar66"}, expect=401)
    req("POST", "/auth/login", {"username": "admin", "password": changed_password})
    renamed = req(
        "POST",
        "/auth/change-username",
        {"current_password": changed_password, "new_username": changed_username},
        changed["token"],
    )
    req("GET", "/auth/me", token=changed["token"], expect=401)
    req("POST", "/auth/login", {"username": "admin", "password": changed_password}, expect=401)
    req("POST", "/auth/login", {"username": changed_username, "password": changed_password})
    # Restore the public fixture so other CI smoke steps never depend on a generated credential.
    restored_name = req(
        "POST",
        "/auth/change-username",
        {"current_password": changed_password, "new_username": "admin"},
        renamed["token"],
    )
    req(
        "POST",
        "/auth/change-password",
        {"current_password": changed_password, "new_password": "Deep@Sonar66"},
        restored_name["token"],
    )
    print("默认人类管理员登录、改密、改名及旧会话吊销 OK")

    # 5. 创建受限 token（tasks:read），明文只返回一次
    t = req(
        "POST",
        "/tokens",
        {"name": f"ci-{uuid.uuid4().hex[:6]}", "scopes": ["tasks:read"]},
        ADMIN,
        201,
    )
    plaintext = t["token"]
    assert plaintext.startswith("deepsonar_dev_") and t["token_prefix"] in plaintext
    tid = t["id"]
    lst = req("GET", "/tokens", token=ADMIN)
    row = next(x for x in lst if x["id"] == tid)
    assert "token" not in row and "token_hash" not in row
    print("创建 OK（列表无明文/哈希）:", plaintext[:20] + "…")

    # 5. scope 判定
    req("GET", "/jobs", token=plaintext)
    req("POST", "/projects", {"name": "x"}, plaintext, 403)
    req("GET", "/tokens", token=plaintext, expect=403)
    req("POST", "/jobs/" + uuid.uuid4().hex + "/cancel", None, plaintext, 403)
    print("scope 判定 OK（读放行/写 403）")

    image_reader = req(
        "POST",
        "/tokens",
        {"name": f"images-read-{uuid.uuid4().hex[:6]}", "scopes": ["images:read"]},
        ADMIN,
        201,
    )
    req("GET", "/runtime-images", token=image_reader["token"])
    req(
        "POST",
        "/runtime-images/import",
        {
            "image_key": "scope-must-block",
            "name": "Scope must block",
            "publisher": "CI",
            "image_ref": "ghcr.io/example/scope-must-block:1",
        },
        image_reader["token"],
        403,
    )
    req("POST", f"/tokens/{image_reader['id']}/revoke", None, ADMIN)
    print("镜像市场 scope 判定 OK（images:read 不可导入）")

    # 6. 项目限定 token
    if projects:
        pid = projects[0]["id"]
        pt = req(
            "POST",
            "/tokens",
            {
                "name": f"proj-only-{uuid.uuid4().hex[:4]}",
                "scopes": ["projects:read", "admin"],
                "project_id": pid,
            },
            ADMIN,
            201,
        )
        req("GET", f"/projects/{pid}", token=pt["token"])
        others = [p["id"] for p in projects if p["id"] != pid]
        if others:
            req("GET", f"/projects/{others[0]}", token=pt["token"], expect=403)
        req("POST", f"/tokens/{pt['id']}/revoke", None, ADMIN)
        print("项目限定 OK")
    else:
        # 无项目时先建一个再测
        p = req("POST", "/projects", {"name": f"auth-ci-{uuid.uuid4().hex[:6]}"}, ADMIN, 201)
        pt = req(
            "POST",
            "/tokens",
            {
                "name": f"proj-only-{uuid.uuid4().hex[:4]}",
                "scopes": ["projects:read"],
                "project_id": p["id"],
            },
            ADMIN,
            201,
        )
        req("GET", f"/projects/{p['id']}", token=pt["token"])
        req("POST", f"/tokens/{pt['id']}/revoke", None, ADMIN)
        print("项目限定 OK（自建项目）")

    # 7. 吊销 → 立即 401
    req("POST", f"/tokens/{tid}/revoke", None, ADMIN)
    req("GET", "/jobs", token=plaintext, expect=401)
    print("吊销 OK")

    # 8. 轮换
    t2 = req("POST", "/tokens", {"name": "rot", "scopes": ["tasks:read"]}, ADMIN, 201)
    t3 = req("POST", f"/tokens/{t2['id']}/rotate", None, ADMIN, 201)
    assert t3["rotated_from"] == t2["id"] and t3["token"] != t2["token"]
    req("GET", "/jobs", token=t3["token"])
    req("GET", "/jobs", token=t2["token"], expect=401)
    req("POST", f"/tokens/{t3['id']}/revoke", None, ADMIN)
    print("轮换 OK")

    # 9. 过期 token → 401
    t4 = req(
        "POST",
        "/tokens",
        {"name": "exp", "scopes": ["tasks:read"], "expires_in_days": 1},
        ADMIN,
        201,
    )
    if expire_token(t4["id"]):
        req("GET", "/jobs", token=t4["token"], expect=401)
        print("过期判定 OK")
    else:
        print("SKIP 过期判定（无 psql/docker 改库能力）")
    req("POST", f"/tokens/{t4['id']}/revoke", None, ADMIN)

    print("OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)
