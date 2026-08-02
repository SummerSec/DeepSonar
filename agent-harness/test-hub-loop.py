# -*- coding: utf-8 -*-
"""Hub 最小循环 E2E（fake 模式，自举项目，可 CI）。

路径：task → hub → audit → finding → verify(rework) → hub 补证(review+test) →
      verify(confirmed) → hub complete → report → root succeeded
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("DEEPSONAR_BASE", "http://127.0.0.1:3100").rstrip("/")
TIMEOUT_SEC = int(os.environ.get("DEEPSONAR_HUB_SMOKE_TIMEOUT", "420"))


def req(method: str, path: str, body=None, expect: int | None = 200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
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
        if expect is None:
            return code, payload
        raise AssertionError(f"{method} {path} -> {code}: {payload}") from None
    if expect is not None and code != expect:
        raise AssertionError(f"{method} {path} -> {code}（期望 {expect}）: {payload}")
    return payload


def main() -> None:
    tag = uuid.uuid4().hex[:6]
    project = req("POST", "/projects", {"name": f"hub-ci-{tag}"}, 201)
    pid = project["id"]
    print("project:", pid)

    # Hub 与 Worker 出网均为全局默认开启；项目仍可覆盖关闭。
    settings = req("GET", f"/projects/{pid}/settings")
    assert settings["effective_rules"]["hubEnabled"] is True
    assert settings["effective_rules"]["allowEgress"] is True
    print("effective_rules:", json.dumps(settings.get("effective_rules", {}), ensure_ascii=False))

    task = req(
        "POST",
        f"/projects/{pid}/tasks",
        {
            "title": f"hub循环演示-{tag}",
            "content": "找出可利用漏洞并确认（CI fake 路径）",
        },
        201,
    )
    cid = task["canvas_id"]
    job = task["job"]
    assert job["type"] == "hub_reason", job
    print("canvas:", cid[:8], "entry_job:", job["id"][:8])

    deadline = time.time() + TIMEOUT_SEC
    root_succeeded = False
    while time.time() < deadline:
        data = req("GET", f"/canvases/{cid}")
        nodes, edges = data["nodes"], data["edges"]
        root = next((n for n in nodes if n["node_type"] == "root"), None)
        summary: dict[str, int] = {}
        for n in nodes:
            key = f"{n['node_type']}:{n['status']}"
            summary[key] = summary.get(key, 0) + 1
        print(f"[{int(deadline - time.time())}s] nodes={summary} edges={[e['edge_type'] for e in edges]}")
        if root and root["status"] == "succeeded":
            root_succeeded = True
            print("== hub 循环收敛：root succeeded ==")
            print("conclusion:", (root.get("body_json") or {}).get("conclusion"))
            break
        time.sleep(2)

    if not root_succeeded:
        jobs = req("GET", f"/jobs?project_id={pid}")
        for j in jobs:
            if j.get("canvas_id") == cid:
                print(f"  job {j['type']:14s} {j['status']:12s} {str(j.get('error'))[:80]}")
        raise AssertionError(f"hub 循环 {TIMEOUT_SEC}s 内未收敛")

    # 边断言：至少形成 Hub→Audit→Finding→Verify 链
    data = req("GET", f"/canvases/{cid}")
    nodes, edges = data["nodes"], data["edges"]
    hubs = [n for n in nodes if n["node_type"] == "job" and (n.get("body_json") or {}).get("type") == "hub_reason"]
    audits = [n for n in nodes if n["node_type"] == "intent" and (n.get("body_json") or {}).get("role") == "audit"]
    findings = [n for n in nodes if n["node_type"] == "finding"]
    verifies = [n for n in nodes if n["node_type"] == "job" and (n.get("body_json") or {}).get("type") == "verify_finding"]
    assert hubs, "缺少 hub 节点"
    assert audits, "缺少 audit intent"
    assert findings, "缺少 finding"
    assert verifies, "缺少 verify job"
    pairs = {(e["from_node_id"], e["to_node_id"], e["edge_type"]) for e in edges}
    assert any((a["id"], f["id"], "produces") in pairs for a in audits for f in findings), "缺少 produces 边"
    assert any((f["id"], v["id"], "verifies") in pairs for f in findings for v in verifies), "缺少 verifies 边"
    print("链 OK: Hub → Audit → Finding → Verify → … → complete → report")

    # 报告应已生成（Root succeeded 前须 Report 成功）
    try:
        report = req("GET", f"/canvases/{cid}/report")
        print("report:", report.get("status"), "confirmed=", (report.get("summary_json") or {}).get("confirmed_count"))
        assert report.get("status") == "succeeded", report
    except AssertionError:
        raise
    except Exception as e:
        print("report check skipped/fail:", e)

    req("POST", f"/projects/{pid}/archive", None)
    print("OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)
