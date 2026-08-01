# -*- coding: utf-8 -*-
"""阶段 A 验收：本地项目/任务 API（docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md §11）
覆盖：本地项目 CRUD/归档、任务创建（画布+root+pending job）、优先级、重试、Plane 绑定/解绑
"""
import json
import time
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


def main():
    tag = uuid.uuid4().hex[:6]

    # 1. 创建纯本地项目（plane_project_id = NULL）
    p = req("POST", "/projects", {"name": f"本地项目-{tag}", "description": "阶段A验收"}, 201)
    pid = p["id"]
    assert p["plane_project_id"] is None and p["status"] == "active", p
    print("本地项目:", pid, p["status"], p["plane_project_id"])

    # 2. 列表/详情带新字段；可创建多个 NULL plane 项目
    p2 = req("POST", "/projects", {"name": f"本地项目2-{tag}"}, 201)
    lst = req("GET", "/projects")
    null_plane = [x for x in lst if x["plane_project_id"] is None]
    assert len(null_plane) >= 2, "多个 plane_project_id=NULL 的本地项目应共存"
    detail = req("GET", f"/projects/{pid}")
    assert detail["description"] == "阶段A验收"
    print("列表/详情 OK，NULL plane 项目数:", len(null_plane))

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
    assert job["status"] == "pending" and job["priority"] == 0 and job["canvas_id"] == cid
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

    # 7. 等 job 终态后重试：复用原画布，历史保留
    final = None
    for _ in range(40):
        j = req("GET", f"/jobs/{job['id']}")["job"]
        if j["status"] in ("succeeded", "failed", "timeout", "cancelled"):
            final = j["status"]
            break
        time.sleep(2)
    assert final, "job 未在 80s 内到达终态"
    before = next(r for r in req("GET", f"/projects/{pid}/canvases") if r["id"] == cid)["job_count"]
    retry = req("POST", f"/tasks/{cid}/retry", None, 201)
    assert retry["canvas_id"] == cid and retry["status"] == "pending"
    rows = req("GET", f"/projects/{pid}/canvases")
    row = next(r for r in rows if r["id"] == cid)
    # fake 执行器跑完 audit 会立刻派生 verify followup，期间可能再多 1 个 job，故只断言至少 +1
    assert row["job_count"] >= before + 1, f"重试后应至少多 1 个 job，{before} → {row['job_count']}"
    print(f"重试 OK: 首跑 {final} → 新 job {retry['id'][:8]}，尝试次数 {row['job_count']}")

    # 8. Plane 绑定/解绑（不依赖真实 Plane 服务）
    req("PUT", f"/projects/{pid}/integrations/plane", {"plane_project_id": f"plane-{tag}"})
    assert req("GET", f"/projects/{pid}")["plane_project_id"] == f"plane-{tag}"
    req("DELETE", f"/projects/{pid}/integrations/plane")
    assert req("GET", f"/projects/{pid}")["plane_project_id"] is None
    print("Plane 绑定/解绑 OK")

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
    main()
