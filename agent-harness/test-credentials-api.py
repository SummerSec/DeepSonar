# -*- coding: utf-8 -*-
"""Provider Credential 验收：加密存储 + RoleConfig 绑定。
前置：调度器配置 DEEPSONAR_MASTER_KEY_FILE 且使用当前 schema 基线。
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
        ["docker", "exec", "deepsonar-postgres", "psql", "-U", "deepsonar", "-d", "deepsonar", "-tA", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def main():
    secret = f"sk-test-{uuid.uuid4().hex}"
    tag = uuid.uuid4().hex[:6]

    # 1. 登记：返回安全字段（无明文/密文）；库中无明文
    c = req("POST", "/credentials", {
        "name": f"anthropic-{tag}", "provider": "anthropic", "secret": secret,
        "metadata": {"base_url": "https://api.anthropic.com"},
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

    # 4. RoleConfig 绑定：创建临时角色并绑定 Credential
    role = req("POST", "/agent-roles", {
        "name": f"cred_test_{tag}", "title": "Credential 测试", "description": "临时验收角色",
    })
    role_id = role["id"]
    role_config = {
        "agent_cli": "claude-code", "model": None, "reasoning": None,
        "env_keys": [], "env_vars": {}, "modules": [], "skills": [], "commands": [],
        "mcps": [], "subagents": [], "instructions_markdown": None, "runtime_image_key": None,
        "credentials": [{"credential_id": cid, "purpose": "llm"}], "config_files": [],
    }
    cfg = req("PUT", f"/role-configs/global/{role_id}", role_config)
    assert cfg["credentials"][0]["credential_id"] == cid
    print("RoleConfig 绑定 OK:", role["name"], "→", cfg["credentials"][0]["provider"])

    # 5. provider PATCH schema：claude-code 绑定的 Credential 禁止迁移到 openai
    req("PATCH", f"/credentials/{cid}", {"provider": "openai"}, expect=400)
    print("claude-code provider 兼容性拒绝 OK")

    # 5.1 leftover allowed_model_ids 静默忽略；普通 metadata 更新需审计
    ignored = req("PATCH", f"/credentials/{cid}", {
        "metadata": {"allowed_model_ids": ["claude-sonnet-4-5"], "base_url": "https://api.anthropic.com/v1/"},
    })
    assert "allowed_model_ids" not in ignored["public_metadata_json"]
    updated = req("PATCH", f"/credentials/{cid}", {
        "name": f"anthropic-updated-{tag}",
        "metadata": {"base_url": "https://api.anthropic.com/v1/"},
    })
    assert updated["public_metadata_json"]["base_url"] == "https://api.anthropic.com/v1"
    assert "allowed_model_ids" not in updated["public_metadata_json"]
    assert updated["impact"]["role_config_count"] == 1
    logs = req("GET", "/audit-logs?action=credential.update&limit=20")
    assert any(log.get("resource_id") == cid for log in logs), "Credential 更新必须写审计日志"
    print("metadata 一致性校验与更新审计 OK")

    # 6. 连接测试（假密钥 → 连接失败/401 均可，验证调用路径与无明文回显）
    t = req("POST", f"/credentials/{cid}/test")
    assert "ok" in t and secret not in json.dumps(t)
    print("连接测试路径 OK:", t["ok"], t["detail"][:60])

    # 7. 禁用 → executor 视角不可用；再启用
    req("POST", f"/credentials/{cid}/status", {"status": "disabled"})
    assert next(x for x in req("GET", "/credentials") if x["id"] == cid)["status"] == "disabled"
    req("POST", f"/credentials/{cid}/status", {"status": "active"})
    print("禁用/启用 OK")

    # 8. 轮换：指纹/last4 变化，key_version+1，旧明文彻底消失
    new_secret = f"sk-rotated-{uuid.uuid4().hex}"
    r = req("POST", f"/credentials/{cid}/rotate", {"secret": new_secret})
    assert r["last4"] == new_secret[-4:] and r["key_version"] == 2 and r["fingerprint"] != c["fingerprint"]
    row = psql(f"SELECT ciphertext FROM credentials WHERE id='{cid}';")
    assert secret not in row and new_secret not in row
    print("轮换 OK: v2，指纹已变")

    # 9. 解绑：RoleConfig 整体 PUT，credentials=[]
    role_config["credentials"] = []
    cfg = req("PUT", f"/role-configs/global/{role_id}", role_config)
    assert cfg["credentials"] == []
    print("解绑 OK")

    # 清理
    req("DELETE", f"/agent-roles/{role_id}")
    psql(f"DELETE FROM credentials WHERE id='{cid}';")
    print("OK")


if __name__ == "__main__":
    main()
