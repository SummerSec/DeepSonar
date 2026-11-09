# -*- coding: utf-8 -*-
"""阶段 A 验收：本地项目/任务 API（docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md §11）
覆盖：本地项目 CRUD/归档、任务创建（画布+root+pending job）、优先级、重试
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("DEEPSONAR_BASE", "http://127.0.0.1:3100").rstrip("/")


def req(method, path, body=None, expect=200):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            code, payload = resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        code, payload = e.code, json.loads(e.read().decode("utf-8") or "{}")
    if expect is None:
        return code, payload
    assert code == expect, f"{method} {path} -> {code}（期望 {expect}）: {payload}"
    return payload


def main():
    tag = uuid.uuid4().hex[:6]

    # 1. 创建项目
    p = req("POST", "/projects", {"name": f"本地项目-{tag}", "description": "阶段A验收"}, 201)
    pid = p["id"]
    assert p["status"] == "active" and "plane_project_id" not in p and "canvas_id" not in p, p
    print("本地项目:", pid, p["status"])

    # 2. 列表/详情；可创建多个项目
    p2 = req("POST", "/projects", {"name": f"本地项目2-{tag}"}, 201)
    lst = req("GET", "/projects")
    assert len([x for x in lst if x["id"] in {pid} or x["name"].endswith(f"-{tag}")]) >= 2, lst
    detail = req("GET", f"/projects/{pid}")
    assert detail["description"] == "阶段A验收"
    assert "plane_project_id" not in detail and "canvas_id" not in detail, detail
    print("列表/详情 OK，项目数:", len(lst))

    # 3. 改名 + 描述
    req("PATCH", f"/projects/{pid}", {"name": f"改名-{tag}", "description": "d2"})
    assert req("GET", f"/projects/{pid}")["name"] == f"改名-{tag}"
    print("PATCH 改名 OK")

    # 4. 创建任务：同事务建画布 + root 节点 + pending job
    t = req("POST", f"/projects/{pid}/tasks", {
        "title": "审计 auth 模块",
        "content": "重点检查认证模块中的注入和权限绕过问题",
    }, 201)
    cid, job = t["canvas_id"], t["job"]
    assert job["status"] == "pending" and job["priority"] > 0 and job["canvas_id"] == cid
    assert job["type"] == "hub_reason", "所有任务必须先由 Hub 决策"
    canvas = req("GET", f"/canvases/{cid}")
    roots = [n for n in canvas["nodes"] if n["node_type"] == "root"]
    assert len(roots) == 1 and "认证模块" in roots[0]["body_json"]["target"]["content"]
    print("任务创建 OK: canvas", cid[:8], "job", job["id"][:8], job["status"])

    # 5. 任务列表聚合：最近一次 job 状态/优先级/尝试次数
    # （fake 执行器是事件驱动的，审计 job 可能已完成并派生 verify followup，job_count 可能已 >1）
    rows = req("GET", f"/projects/{pid}/canvases")
    row = next(r for r in rows if r["id"] == cid)
    assert row["job_count"] >= 1 and row["last_job_status"] in (
        "pending", "claimed", "provisioning", "running", "succeeded", "waiting_human",
    ), row
    assert row["last_job_priority"] >= 0
    # Lifecycle rollups: canvas creation is the origin; pending work has no fake start;
    # an active task cannot expose a terminal end timestamp.
    assert row["created_at"]
    assert "started_at" in row and "ended_at" in row
    if row["active_count"] > 0:
        assert row["ended_at"] is None, row
    if row["started_at"] is None and row["last_job_status"] == "pending":
        assert row["ended_at"] is None, row
    print("任务聚合 OK:", row["last_job_status"], "priority", row["last_job_priority"])

    # 6. 优先级：pending 可改（job 可能已被 fake 调度跑掉，两种结果都合法）
    r = req("PATCH", f"/jobs/{job['id']}/priority", {"priority": 99}, expect=None) if False else None
    # 用专门断言：可能 200（还 pending）或 409（已被认领）
    data = json.dumps({"priority": 99}).encode()
    request = urllib.request.Request(BASE + f"/jobs/{job['id']}/priority", data=data, method="PATCH",
                                     headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    assert code in (200, 409), f"priority 改动返回 {code}"
    print("优先级:", code, "(200=改成功 / 409=已被认领，均合法)")

    # 7. 已沉淀任务保留原历史；无治理留存的任务仍可安全硬重试。
    # fake hub 每轮派多角色 + finding 必验 + followup 回收，链长已到 ~8 分钟，窗口放宽到 15 分钟
    final = None
    for _ in range(450):
        j = req("GET", f"/jobs/{job['id']}")["job"]
        graph = req("GET", f"/canvases/{cid}")
        root = next(n for n in graph["nodes"] if n["node_type"] == "root")
        if root["status"] == "succeeded":
            final = j["status"]
            break
        time.sleep(2)
    assert final, "Hub 编排链未在 15 分钟内收敛"

    # 边断言需轮询：root 可能先于后续验收轮的 next 边到达 succeeded（链仍在演进）
    def hub_chain_ok():
        g = req("GET", f"/canvases/{cid}")
        nodes, edges = g["nodes"], g["edges"]
        roots = [n for n in nodes if n["node_type"] == "root"]
        hubs = [n for n in nodes if n["node_type"] == "job" and n["body_json"].get("type") == "hub_reason"]
        audits = [n for n in nodes if n["node_type"] == "intent" and n["body_json"].get("role") == "audit"]
        findings = [n for n in nodes if n["node_type"] == "finding"]
        reviews = [n for n in nodes if n["node_type"] == "intent" and n["body_json"].get("role") == "review"]
        tests = [n for n in nodes if n["node_type"] == "intent" and n["body_json"].get("role") == "test"]
        verifies = [n for n in nodes if n["node_type"] == "job" and n["body_json"].get("type") == "verify_finding"]
        if verifies or not (roots and len(hubs) >= 2 and audits and findings and reviews and tests):
            return False
        pairs = {(e["from_node_id"], e["to_node_id"], e["edge_type"]) for e in edges}
        return (
            (roots[0]["id"], hubs[0]["id"], "child") in pairs
            and any((a["id"], f["id"], "produces") in pairs for a in audits for f in findings)
            and any(e["from_node_id"] in {f["id"] for f in findings} and e["edge_type"] == "next" for e in edges)
        )

    chain_deadline = time.time() + 120
    while not hub_chain_ok():
        assert time.time() < chain_deadline, "Hub→Audit→Finding→补证 Fact→Hub 节点/边链 120s 内未成形"
        time.sleep(3)
    print("Hub 编排链 OK: Root → Hub → Audit → Finding → 补证 Fact → Hub")

    # root succeeded ≠ 链上没有活动 job（验收轮可能仍在跑）；retry 要求画布无活动 job，等彻底收敛
    ACTIVE = {"pending", "claimed", "provisioning", "running", "waiting_human"}
    def active_jobs():
        return [j for j in req("GET", f"/jobs?project_id={pid}")
                if j.get("canvas_id") == cid and j["status"] in ACTIVE]

    quiesce_deadline = time.time() + 600
    while active_jobs():
        assert time.time() < quiesce_deadline, "画布活动 job 10 分钟内未清空（无法安全重试）"
        time.sleep(5)

    # Once all work is terminal, the rollup freezes the latest finished_at as ended_at.
    settled = next(r for r in req("GET", f"/projects/{pid}/canvases") if r["id"] == cid)
    assert settled["active_count"] == 0 and settled["ended_at"], settled
    if settled["started_at"]:
        assert settled["started_at"] <= settled["ended_at"], settled

    old_job_ids = {
        item["id"] for item in req("GET", f"/jobs?project_id={pid}")
        if item.get("canvas_id") == cid
    }
    before_work = {
        item["work"]["id"]: item["work"]["job_count"]
        for item in req("GET", f"/projects/{pid}/knowledge/backfill?limit=20")["items"]
        if item["job_id"] in old_job_ids and item.get("work")
    }
    assert before_work, "成功业务任务应留下自动治理 work"
    retained = req("POST", f"/tasks/{cid}/retry", None, 409)
    assert retained["error_code"] == "TASK_DELETE_KNOWLEDGE_RETAINED", retained
    assert retained["retained"].get("work", 0) > 0, retained
    preserved_job_ids = {
        item["id"] for item in req("GET", f"/jobs?project_id={pid}")
        if item.get("canvas_id") == cid
    }
    assert old_job_ids == preserved_job_ids, "治理历史保留拒绝不得删除原 Job"
    after_work = {
        item["work"]["id"]: item["work"]["job_count"]
        for item in req("GET", f"/projects/{pid}/knowledge/backfill?limit=20")["items"]
        if item["job_id"] in old_job_ids and item.get("work")
    }
    assert before_work.keys() <= after_work.keys(), "硬重试拒绝不得删除既有 work"
    assert all(after_work[work_id] >= count for work_id, count in before_work.items()), "硬重试拒绝不得重置知识预算"
    print("已沉淀任务硬重试拒绝 OK，原 Job 与治理记录保留")

    # 冻结到未来，确保这个独立任务不会产生执行或知识记录；取消 pending 入口后验证干净重试。
    clean = req("POST", f"/projects/{pid}/tasks", {
        "title": "无治理留存的硬重试",
        "content": "仅验证未来调度任务的取消与硬重试，不执行模型任务",
        "allow_egress": False,
        "scheduled_start_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
    }, 201)
    clean_cid, clean_job = clean["canvas_id"], clean["job"]
    clean_current = req("GET", f"/jobs/{clean_job['id']}")["job"]
    assert clean_current["status"] == "pending", clean_current
    cancelled = req("POST", f"/jobs/{clean_job['id']}/cancel", None)
    assert cancelled["status"] == "cancelled", cancelled
    clean_row = next(r for r in req("GET", f"/projects/{pid}/canvases") if r["id"] == clean_cid)
    assert clean_row["active_count"] == 0, clean_row
    # Hub不在业务Job补做目录中；后续201会经过统一保留门，证明该干净任务没有治理留存。
    retry = req("POST", f"/tasks/{clean_cid}/retry", None, 201)
    assert retry["canvas_id"] == clean_cid and retry["status"] == "pending", retry
    current_job_ids = {
        item["id"] for item in req("GET", f"/jobs?project_id={pid}")
        if item.get("canvas_id") == clean_cid
    }
    assert retry["id"] in current_job_ids, "硬重试创建的新入口 Job 应属于原画布"
    assert clean_job["id"] not in current_job_ids, "无治理留存的硬重试应清空其原 Job"
    rows = req("GET", f"/projects/{pid}/canvases")
    row = next(r for r in rows if r["id"] == clean_cid)
    assert row["job_count"] >= 1, row
    print(f"干净硬重试 OK: 新 job {retry['id'][:8]}，新一轮 job 数 {row['job_count']}")

    # 8. 外部事件触发：进入 Hub，且 source + event_id 幂等
    event_body = {
        "event_id": f"evt-{tag}",
        "source": "ci",
        "event_type": "security_scan_failed",
        "data": {"repository": "demo", "branch": "main", "alert_count": 2},
    }
    event_first = req("POST", f"/projects/{pid}/events", event_body, 201)
    event_second = req("POST", f"/projects/{pid}/events", event_body, 200)
    assert event_first["job"]["type"] == "hub_reason"
    assert event_second["duplicated"] is True
    assert event_second["canvas_id"] == event_first["canvas_id"]
    assert event_second["job"]["id"] == event_first["job"]["id"]
    print("事件触发 OK: 首次创建，重复事件幂等复用", event_first["canvas_id"][:8])

    # 9. 归档：归档后不能新建任务；历史数据保留
    req("POST", f"/projects/{pid}/archive", None)
    assert req("GET", f"/projects/{pid}")["status"] == "archived"
    req("POST", f"/projects/{pid}/tasks", {"title": "应被拒", "content": "项目已归档"}, expect=409)
    assert req("GET", f"/canvases/{cid}")["nodes"], "归档后历史画布必须保留"
    # 恢复
    req("PATCH", f"/projects/{pid}", {"status": "active"})
    assert req("GET", f"/projects/{pid}")["status"] == "active"
    print("归档/恢复 OK，历史数据保留")

    # 清理第二个测试项目（归档即可，不硬删）
    req("POST", f"/projects/{p2['id']}/archive", None)
    req("POST", f"/projects/{pid}/archive", None)

    print("OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)
