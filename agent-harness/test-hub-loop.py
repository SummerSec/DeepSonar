# -*- coding: utf-8 -*-
"""Hub 最小循环 E2E（fake 模式，自举项目，可 CI）。

主路径（必须 confirmed，不得靠 maxHubRounds 护栏假绿）：
task → hub → audit → finding → verify(rework) → hub 补证(review+test) →
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
# Hub 轮次硬上限默认 100；主闭环应远小于此，否则是 Report 时序回归
MAX_HUB_JOBS = int(os.environ.get("DEEPSONAR_HUB_SMOKE_MAX_HUBS", "20"))
MAX_TOTAL_JOBS = int(os.environ.get("DEEPSONAR_HUB_SMOKE_MAX_JOBS", "40"))


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
    root_body = {}
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
            root_body = root.get("body_json") or {}
            print("== hub 循环收敛：root succeeded ==")
            print("conclusion:", root_body.get("conclusion"))
            break
        time.sleep(2)

    if not root_succeeded:
        jobs = req("GET", f"/jobs?project_id={pid}")
        for j in jobs:
            if j.get("canvas_id") == cid:
                print(f"  job {j['type']:14s} {j['status']:12s} {str(j.get('error'))[:80]}")
        raise AssertionError(f"hub 循环 {TIMEOUT_SEC}s 内未收敛")

    conclusion = str(root_body.get("conclusion") or "")
    guardrail = root_body.get("guardrail")
    assert guardrail != "max_hub_rounds", f"假绿：靠 maxHubRounds 护栏出报告，conclusion={conclusion!r}"
    assert "决策轮次达上限" not in conclusion and "max_hub_rounds" not in conclusion.lower(), (
        f"假绿：Root 结论为护栏降级路径：{conclusion!r}"
    )

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

    # Finding 必须 confirmed（主路径），不得以 needs_human 护栏冒充
    flist = req("GET", f"/findings?project_id={pid}&canvas_id={cid}")
    if isinstance(flist, dict):
        flist = flist.get("findings") or flist.get("items") or flist.get("data") or []
    confirmed_findings = [f for f in flist if f.get("verify_status") == "confirmed"]
    print("findings:", [(f.get("title"), f.get("verify_status")) for f in flist])
    assert confirmed_findings, (
        f"主路径要求至少一条 Finding verify_status=confirmed，实际={[f.get('verify_status') for f in flist]}"
    )

    # Job 数量护栏：不得烧满 maxHubRounds
    jobs_all = req("GET", f"/jobs?project_id={pid}")
    if isinstance(jobs_all, dict):
        jobs_all = jobs_all.get("jobs") or jobs_all.get("items") or jobs_all.get("data") or []
    canvas_jobs = [j for j in jobs_all if j.get("canvas_id") == cid]
    hub_jobs = [j for j in canvas_jobs if j.get("type") == "hub_reason"]
    print(f"jobs total={len(canvas_jobs)} hub={len(hub_jobs)}")
    assert len(hub_jobs) <= MAX_HUB_JOBS, (
        f"Hub 轮次过多 {len(hub_jobs)} > {MAX_HUB_JOBS}（疑似 Report 时序回归烧 maxHubRounds）"
    )
    assert len(canvas_jobs) <= MAX_TOTAL_JOBS, (
        f"Job 总数过多 {len(canvas_jobs)} > {MAX_TOTAL_JOBS}"
    )

    # 报告：必须 succeeded 且 confirmed_count >= 1
    report = req("GET", f"/canvases/{cid}/report")
    summary = report.get("summary_json") or {}
    print("report:", report.get("status"), "confirmed=", summary.get("confirmed_count"))
    assert report.get("status") == "succeeded", report
    confirmed_count = int(summary.get("confirmed_count") or 0)
    assert confirmed_count >= 1, (
        f"假绿：report confirmed_count={confirmed_count}（护栏 needs_human 路径不可冒充主闭环） summary={summary}"
    )

    req("POST", f"/projects/{pid}/archive", None)
    print("OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)
