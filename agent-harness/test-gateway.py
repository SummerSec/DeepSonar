# -*- coding: utf-8 -*-
"""GW 工作包验收（§6.3）：Model Gateway + 短期 DFH_JOB_TOKEN
前置：调度器 3100 已应用 0016 迁移
流程：mock 上游 → Credential(base_url=mock) → SQL 造 running job + job_token →
      转发/认证注入/usage 计数/模型限制/额度/终态吊销 全链路断言
"""
import hashlib
import json
import secrets
import subprocess
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = "http://localhost:3100"
MOCK_PORT = 9911
captured = {}


class MockUpstream(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        captured["body"] = self.rfile.read(n).decode("utf-8")
        captured["x-api-key"] = self.headers.get("x-api-key")
        captured["authorization"] = self.headers.get("authorization")
        captured["path"] = self.path
        payload = json.dumps({
            "id": "msg_mock", "type": "message",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


def psql(sql, first_line=False):
    out = subprocess.run(
        ["docker", "exec", "dfh-postgres", "psql", "-U", "dfh", "-d", "deepflowhunter", "-tA", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    # INSERT/UPDATE ... RETURNING 会附带命令标签行（INSERT 0 1），取首行
    return out.splitlines()[0].strip() if first_line else out


def api(method, path, body=None, token=None, expect=200):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            code, payload = resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        code, payload = e.code, json.loads(e.read().decode() or "{}")
    assert code == expect, f"{method} {path} -> {code}（期望 {expect}）: {payload}"
    return payload


def main():
    server = HTTPServer(("127.0.0.1", MOCK_PORT), MockUpstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tag = uuid.uuid4().hex[:6]

    # 1. Credential 指向 mock 上游
    cred = api("POST", "/credentials", {
        "name": f"gw-mock-{tag}", "provider": "anthropic", "secret": "sk-mock-secret",
        "metadata": {"base_url": f"http://localhost:{MOCK_PORT}"},
    }, expect=201)
    cid = cred["id"]
    print("credential OK:", cid[:8])

    # 2. SQL 造 running job + project
    pid = psql("INSERT INTO projects (name, canvas_id) VALUES "
               f"('gw-test-{tag}', gen_random_uuid()::text) RETURNING id;", first_line=True)
    jid = psql(f"INSERT INTO jobs (project_id, type, status, started_at) VALUES "
               f"('{pid}', 'audit', 'running', now()) RETURNING id;", first_line=True)

    # 3. 铸造 job token（python 侧算 sha256，与 TS hashJobToken 一致）
    prefix = secrets.token_hex(4)
    secret = secrets.token_urlsafe(24)
    plaintext = f"dfhjob_{prefix}_{secret}"
    th = hashlib.sha256(plaintext.encode()).hexdigest()
    psql(f"INSERT INTO job_tokens (job_id, project_id, credential_id, token_prefix, token_hash,"
         f" allowed_models, max_requests, expires_at) VALUES "
         f"('{jid}', '{pid}', '{cid}', '{prefix}', '{th}', "
         f"'{{claude-test}}', 2, now() + interval '1 hour');")

    # 4. 模型不在允许列表 → 403（不消耗请求数）
    r = api("POST", "/gateway/v1/messages", {"model": "claude-evil"}, token=plaintext, expect=403)
    assert r["error"]["type"] == "model_not_allowed"
    print("模型限制 403 OK（不消耗额度）")

    # 5. 正常转发：mock 收到注入的真实认证头；usage 计数
    r = api("POST", "/gateway/v1/messages", {"model": "claude-test", "max_tokens": 1}, token=plaintext)
    assert r["usage"]["input_tokens"] == 10
    assert captured["x-api-key"] == "sk-mock-secret", captured
    assert captured["authorization"] == "Bearer sk-mock-secret"
    assert captured["path"] == "/v1/messages"
    row = psql(f"SELECT used_requests, used_tokens FROM job_tokens WHERE token_prefix='{prefix}';")
    assert row == "1|15", row
    print("转发 OK：认证头注入正确，used_requests=1 used_tokens=15")

    # 6. 第二次可用；第三次 429 额度用尽
    api("POST", "/gateway/v1/messages", {"model": "claude-test"}, token=plaintext)
    r = api("POST", "/gateway/v1/messages", {"model": "claude-test"}, token=plaintext, expect=429)
    assert r["error"]["type"] == "quota_exhausted"
    assert psql(f"SELECT status FROM job_tokens WHERE token_prefix='{prefix}';") == "exhausted"
    print("额度 429 OK（状态 exhausted）")

    # 7. 恢复 active + job 终态 → 401 job_inactive 且 token 被吊销
    psql(f"UPDATE job_tokens SET status='active', used_requests=0 WHERE token_prefix='{prefix}';")
    psql(f"UPDATE jobs SET status='succeeded', finished_at=now() WHERE id='{jid}';")
    r = api("POST", "/gateway/v1/messages", {"model": "claude-test"}, token=plaintext, expect=401)
    assert r["error"]["type"] == "job_inactive"
    assert psql(f"SELECT status, revoke_reason FROM job_tokens WHERE token_prefix='{prefix}';") == "revoked|job_succeeded"
    print("终态吊销 OK：401 job_inactive，token revoked")

    # 8. 非法/不存在 token
    api("POST", "/gateway/v1/messages", {"model": "x"}, token="dfhjob_00000000_" + secrets.token_urlsafe(24), expect=401)
    api("POST", "/gateway/v1/messages", {"model": "x"}, token="not-a-token", expect=401)
    print("非法 token 401 OK")

    # 9. 审计：gateway.denied（model_not_allowed / job_inactive）已落行
    n = psql("SELECT count(*) FROM audit_logs WHERE action IN ('gateway.denied') "
             f"AND resource_id IN (SELECT id::text FROM job_tokens WHERE token_prefix='{prefix}');")
    assert int(n) >= 2, n
    print("网关审计 OK:", n, "行")

    # 清理
    psql(f"DELETE FROM job_tokens WHERE token_prefix='{prefix}';")
    psql(f"DELETE FROM jobs WHERE id='{jid}';")
    psql(f"DELETE FROM projects WHERE id='{pid}';")
    psql(f"DELETE FROM credentials WHERE id='{cid}';")
    server.shutdown()
    print("OK")


if __name__ == "__main__":
    main()
