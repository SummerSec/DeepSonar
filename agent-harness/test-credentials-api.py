# -*- coding: utf-8 -*-
"""CRED 工作包验收（§6.2）：Provider Credential 加密存储 + profile 绑定
前置：调度器配置 DFH_MASTER_KEY_FILE 且已应用 0012 迁移
"""
import json
import subprocess
import urllib.request
import uuid

BASE = "http://localhost:3100"


def req(method, path, body=None, expect=200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            code, payload = resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        code, payload = e.code, json.loads(e.read().decode("utf-8") or "{}")
    assert code == expect, f"{method} {path} -> {code}（期望 {expect}）: {payload}"
    return payload


def psql(sql):
    return subprocess.run(
        ["docker", "exec", "dfh-postgres", "psql", "-U", "dfh", "-d", "deepflowhunter", "-tA", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def main():
    secret = f"sk-test-{uuid.uuid4().hex}"
    tag = uuid.uuid4().hex[:6]

    # 1. 登记：返回安全字段（无明文/密文）；库中无明文
    c = req("POST", "/credentials", {
        "name": f"kimi-{tag}", "provider": "kimi", "secret": secret,
        "metadata": {"base_url": "https://api.kimi.example/coding"},
    }, 201)
    cid = c["id"]
    assert "ciphertext" not in c and "secret" not in c and "nonce" not in c
    assert c["last4"] == secret[-4:] and c["status"] == "active" and len(c["fingerprint"]) == 16
    row = psql(f"SELECT ciphertext, nonce, auth_tag FROM credentials WHERE id='{cid}';")
    assert secret not in row, "库中绝不应出现明文"
    print("登记 OK（无明文/密文返回，库中只有密文）:", c["fingerprint"][:8], "…" + c["last4"])

    # 2. 列表：全部安全字段
    lst = req("GET", "/credentials")
    assert all("ciphertext" not in x for x in lst)
    print("列表 OK:", len(lst), "条")

    # 3. 未知 provider 拒绝（固定映射表）
    req("POST", "/credentials", {"name": "x", "provider": "evil-corp", "secret": "y"}, expect=400)
    print("未知 provider 拒绝 OK")

    # 4. profile 绑定：创建带 credential_id 的 profile → 列表带绑定信息
    p = req("POST", "/agent-profiles", {
        "name": f"cred-prof-{tag}", "agent_cli": "claude-code",
        "env_keys": [], "modules": [], "skills": [], "commands": [], "mcps": [], "subagents": [],
        "credential_id": cid,
    }, 201)
    prof = next(x for x in req("GET", "/agent-profiles") if x["id"] == p["id"])
    assert prof["credential_id"] == cid and prof["credential_provider"] == "kimi"
    print("profile 绑定 OK:", prof["name"], "→", prof["credential_provider"])

    # 5. 连接测试（假密钥 → 连接失败/401 均可，验证调用路径与无明文回显）
    t = req("POST", f"/credentials/{cid}/test")
    assert "ok" in t and secret not in json.dumps(t)
    print("连接测试路径 OK:", t["ok"], t["detail"][:60])

    # 6. 禁用 → executor 视角不可用；再启用
    req("POST", f"/credentials/{cid}/status", {"status": "disabled"})
    assert next(x for x in req("GET", "/credentials") if x["id"] == cid)["status"] == "disabled"
    req("POST", f"/credentials/{cid}/status", {"status": "active"})
    print("禁用/启用 OK")

    # 7. 轮换：指纹/last4 变化，key_version+1，旧明文彻底消失
    new_secret = f"sk-rotated-{uuid.uuid4().hex}"
    r = req("POST", f"/credentials/{cid}/rotate", {"secret": new_secret})
    assert r["last4"] == new_secret[-4:] and r["key_version"] == 2 and r["fingerprint"] != c["fingerprint"]
    row = psql(f"SELECT ciphertext FROM credentials WHERE id='{cid}';")
    assert secret not in row and new_secret not in row
    print("轮换 OK: v2，指纹已变")

    # 8. 解绑：PATCH credential_id=null
    req("PATCH", f"/agent-profiles/{p['id']}", {"credential_id": None})
    prof = next(x for x in req("GET", "/agent-profiles") if x["id"] == p["id"])
    assert prof["credential_id"] is None
    print("解绑 OK")

    # 清理
    req("DELETE", f"/agent-profiles/{p['id']}")
    psql(f"DELETE FROM credentials WHERE id='{cid}';")
    print("OK")


if __name__ == "__main__":
    main()
