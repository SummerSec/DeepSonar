"""Phase① hub 最小循环 E2E（fake 模式）：
1. 项目开启 rules.hubEnabled
2. POST /jobs 造一个审计任务
3. 轮询画布，期待：audit done → hub → intent → explore → fact → hub → complete(root succeeded)
"""
import json, time, urllib.request

BASE = "http://localhost:3100"
PROJECT = "e93a57a1-fe76-4c08-820a-6c9735b83c3d"

def req(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        r.add_header("content-type", "application/json")
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))

# 1. 开启 hub（per-project rules 覆盖）
settings = req("PATCH", f"/projects/{PROJECT}/settings", {"rules": {"hubEnabled": True}})
print("effective_rules:", json.dumps(settings.get("effective_rules", {}), ensure_ascii=False))

# 2. 造任务（带 goal 的 target）
job = req("POST", "/jobs", {
    "project_id": PROJECT,
    "type": "audit_module",
    "title": "hub循环演示：demo-repo 审计",
    "payload": {"module_path": "src", "goal": "找出 demo-repo 中的可利用漏洞并确认"},
})
job_id = job.get("id") or job.get("job", {}).get("id")
print("job:", json.dumps(job, ensure_ascii=False)[:300])

# 找到 canvas_id
canvas_id = job.get("canvas_id")
if not canvas_id:
    jobs = req("GET", f"/jobs?project_id={PROJECT}")
    for j in jobs:
        if j["id"] == job_id:
            canvas_id = j.get("canvas_id")
print("canvas_id:", canvas_id)

# 3. 轮询画布直至 root succeeded（或超时）
deadline = time.time() + 120
seen_types = []
while time.time() < deadline:
    data = req("GET", f"/canvases/{canvas_id}")
    nodes = data["nodes"]
    edges = data["edges"]
    types = [(n["node_type"], n["status"]) for n in nodes]
    root = next((n for n in nodes if n["node_type"] == "root"), None)
    summary = {}
    for t, s in types:
        summary[f"{t}:{s}"] = summary.get(f"{t}:{s}", 0) + 1
    print(f"[{int(deadline - time.time())}s 剩] nodes={summary} edges={[e['edge_type'] for e in edges]}")
    if root and root["status"] == "succeeded":
        print("== hub 循环收敛：root succeeded ==")
        print("conclusion:", (root["body_json"] or {}).get("conclusion"))
        for n in nodes:
            print(f"  {n['node_type']:8s} {n['status']:10s} {n['title'][:60]}")
        for e in edges:
            print(f"  edge {e['edge_type']}: {e['from_node_id'][:8]} -> {e['to_node_id'][:8]}")
        break
    time.sleep(4)
else:
    print("!! 超时未收敛")
    jobs = req("GET", f"/jobs?project_id={PROJECT}")
    for j in jobs:
        if j.get("canvas_id") == canvas_id:
            print(f"  job {j['type']:14s} {j['status']:12s} {str(j.get('error'))[:80]}")

# 收尾：关掉 hub（避免影响后续测试）
req("PATCH", f"/projects/{PROJECT}/settings", {"rules": {"hubEnabled": False}})
print("hubEnabled 已还原为 false")
