#!/usr/bin/env python3
"""
DeepFlowHunter Management API CLI（Management Skill 的脚本入口）

环境变量：
  DFH_BASE_URL   调度器地址（默认 http://localhost:3100）
  DFH_API_TOKEN  Platform API Token（dfh_<env>_<prefix>_<secret>）；auth 关闭时可省略

用法：python dfh-api.py <资源> <动作> [位置参数] [--flag value...]
输出：stdout 单行/多行 JSON（结构化，便于其他 Agent 消费）；错误走 stderr + 非零退出码。
      reports.markdown / reports.sarif 例外：直接输出原文（text/markdown、sarif+json）。

复杂 JSON 参数（--data / --rules / --payload）支持 "@path/to/file.json" 从文件读取。

仅依赖 Python 标准库（3.8+），无需 pip install。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Windows 控制台默认 GBK，强制 UTF-8 输出，保证下游 Agent 消费一致
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

BASE = (os.environ.get("DFH_BASE_URL") or "http://localhost:3100").rstrip("/")
TOKEN = os.environ.get("DFH_API_TOKEN") or ""


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def parse_flags(argv: list[str]) -> tuple[list[str], dict]:
    pos: list[str] = []
    flags: dict = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:]
            nxt = argv[i + 1] if i + 1 < len(argv) else None
            if nxt is None or nxt.startswith("--"):
                flags[key] = True
            else:
                flags[key] = nxt
                i += 1
        else:
            pos.append(a)
        i += 1
    return pos, flags


def parse_json_arg(value: str, name: str):
    """解析 JSON 参数：inline JSON 或 "@文件路径"。"""
    raw = value
    if value.startswith("@"):
        with open(value[1:], "r", encoding="utf-8") as fh:
            raw = fh.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(f"{name} 不是合法 JSON（可用 @文件路径 传入）")


def call(method: str, path: str, body=None):
    # 无 body 时不带 application/json，避免 Fastify FST_ERR_CTP_EMPTY_JSON_BODY
    headers = {}
    if TOKEN:
        headers["authorization"] = f"Bearer {TOKEN}"
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    status = 200
    try:
        with urllib.request.urlopen(req) as res:
            status = res.status
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text) if text else None
    except json.JSONDecodeError:
        parsed = {"raw": text}
    if status >= 400:
        msg = (parsed or {}).get("error") or (parsed or {}).get("message") or f"HTTP {status}"
        if not isinstance(msg, str):
            msg = f"HTTP {status}"
        raise ApiError(msg, status=status, body=parsed)
    return parsed


def call_text(method: str, path: str) -> str:
    """非 JSON 响应（报告下载）：成功返回原文文本，错误仍按 JSON error 抛出。"""
    headers = {}
    if TOKEN:
        headers["authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(BASE + path, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            return res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        msg = f"HTTP {e.code}"
        try:
            msg = json.loads(text).get("error") or msg
        except json.JSONDecodeError:
            pass
        raise ApiError(msg, status=e.code, body={"raw": text[:500]})


def emit(data) -> None:
    if isinstance(data, str):
        sys.stdout.write(data if data.endswith("\n") else data + "\n")
        return
    sys.stdout.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def need(value, name: str):
    if value is None or value == "":
        raise ApiError(f"缺少参数: {name}")
    return value


# ---------- 命令实现：resource.action → (pos, flags) => API 调用 ----------

def _projects_create(_pos, f):
    body = {"name": need(f.get("name"), "--name")}
    if f.get("description"):
        body["description"] = f["description"]
    if f.get("plane-project-id"):
        body["plane_project_id"] = f["plane-project-id"]
    return call("POST", "/projects", body)


def _tasks_create(pos, f):
    title = need(f.get("title"), "--title")
    content = f.get("content") or title
    body = {"title": title, "content": content}
    if f.get("allow-egress") is not None:
        value = str(f["allow-egress"]).lower()
        if value not in ("true", "false"):
            raise ApiError("--allow-egress 必须是 true 或 false")
        body["allow_egress"] = value == "true"
    return call("POST", f"/projects/{need(pos[0] if pos else None, 'projectId')}/tasks", body)


def _events_push(pos, f):
    body = {
        "source": need(f.get("source"), "--source"),
        "event_id": need(f.get("event-id"), "--event-id"),
        "event_type": f.get("event-type") or "generic",
    }
    if f.get("title"):
        body["title"] = f["title"]
    if f.get("content"):
        body["content"] = f["content"]
    if f.get("data"):
        body["data"] = parse_json_arg(str(f["data"]), "--data")
    return call("POST", f"/projects/{need(pos[0] if pos else None, 'projectId')}/events", body)


def _jobs_create(_pos, f):
    body = {
        "project_id": need(f.get("project-id"), "--project-id"),
        "type": need(f.get("type"), "--type"),
    }
    if f.get("title"):
        body["title"] = f["title"]
    if f.get("payload"):
        body["payload"] = parse_json_arg(str(f["payload"]), "--payload")
    if f.get("priority") is not None:
        body["priority"] = int(f["priority"])
    if f.get("timeout-sec") is not None:
        body["timeout_sec"] = int(f["timeout-sec"])
    return call("POST", "/jobs", body)


def _project_settings_update(pos, f):
    body = {}
    if f.get("rules"):
        body["rules"] = parse_json_arg(str(f["rules"]), "--rules")
    if f.get("roles") is not None:
        # --roles "explore,analyze" 设启用清单；--roles null 恢复默认（全部内置）
        roles_val = str(f["roles"])
        enabled = None if roles_val == "null" else [s.strip() for s in roles_val.split(",") if s.strip()]
        body["roles"] = {"enabled": enabled}
    return call("PATCH", f"/projects/{need(pos[0] if pos else None, 'projectId')}/settings", body)


def _roles_create(_pos, f):
    body = {
        "name": need(f.get("name"), "--name（小写字母开头的标识符）"),
    }
    if f.get("title"):
        body["title"] = f["title"]
    if f.get("description"):
        body["description"] = f["description"]
    return call("POST", "/agent-roles", body)


def _skills_create(_pos, f):
    body = {
        "name": need(f.get("name"), "--name"),
        "repo_url": need(f.get("repo-url"), "--repo-url（https，host 白名单，无内嵌凭据）"),
    }
    if f.get("branch"):
        body["branch"] = f["branch"]
    return call("POST", "/skill-sources", body)


def _skills_trust(pos, f):
    body = {"trust_status": need(f.get("status"), "--status quarantined|trusted|disabled")}
    if f.get("enabled") is not None:
        body["enabled"] = str(f["enabled"]).lower() == "true"
    sid = need(pos[0] if pos else None, "sourceId")
    return call("POST", f"/skill-sources/{sid}/trust", body)


def _credentials_create(_pos, f):
    body = {
        "name": need(f.get("name"), "--name"),
        "provider": need(f.get("provider"), "--provider anthropic|kimi|openai|openrouter|plane|git"),
        "secret": need(f.get("secret"), "--secret"),
    }
    if f.get("kind"):
        body["kind"] = f["kind"]
    if f.get("project-id"):
        body["project_id"] = f["project-id"]
    meta = {}
    if f.get("base-url"):
        meta["base_url"] = str(f["base-url"]).rstrip("/")
    if f.get("metadata"):
        meta.update(parse_json_arg(str(f["metadata"]), "--metadata"))
    if meta:
        body["metadata"] = meta
    return call("POST", "/credentials", body)


def _schema_cmd(pos, f):
    """schema openapi|summary|markdown — 拉运行时契约（豁免鉴权）。"""
    kind = (pos[0] if pos else f.get("format") or "summary").lower()
    if kind in ("openapi", "open-api", "json"):
        return call("GET", "/openapi.json")
    if kind in ("summary", "sum"):
        return call("GET", "/schema?format=summary")
    if kind in ("markdown", "md"):
        return call_text("GET", "/schema.md")
    raise ApiError(f"未知 schema 格式: {kind}（openapi|summary|markdown）")


def _p0(pos, name):
    return need(pos[0] if len(pos) > 0 else None, name)


def _p1(pos, name):
    return need(pos[1] if len(pos) > 1 else None, name)


COMMANDS = {
    "health": lambda pos, f: call("GET", "/health"),

    # ---------- API Schema（豁免鉴权；以运行中调度器为准） ----------
    "schema": _schema_cmd,
    "schema.openapi": lambda pos, f: call("GET", "/openapi.json"),
    "schema.summary": lambda pos, f: call("GET", "/schema?format=summary"),
    "schema.markdown": lambda pos, f: call_text("GET", "/schema.md"),

    # ---------- 项目 ----------
    "projects.list": lambda pos, f: call("GET", "/projects"),
    "projects.get": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}"),
    "projects.create": _projects_create,
    # 服务端仅允许 name / description / status（active|archived）
    "projects.update": lambda pos, f: call(
        "PATCH", f"/projects/{_p0(pos, 'projectId')}",
        parse_json_arg(need(f.get("data"), "--data '{\"k\":\"v\"}'"), "--data")),
    "projects.archive": lambda pos, f: call("POST", f"/projects/{_p0(pos, 'projectId')}/archive"),

    # ---------- 任务（一次任务 = 一个画布） ----------
    "tasks.create": _tasks_create,
    "tasks.retry": lambda pos, f: call("POST", f"/tasks/{_p0(pos, 'canvasId')}/retry"),

    # ---------- 事件注入（幂等：source + event_id） ----------
    "events.push": _events_push,

    # ---------- Job ----------
    "jobs.list": lambda pos, f: call("GET", f"/jobs?project_id={f['project']}" if f.get("project") else "/jobs"),
    "jobs.get": lambda pos, f: call("GET", f"/jobs/{_p0(pos, 'jobId')}"),
    # 直接建 job（type 须为已注册 agent_roles.name 或系统类型；一般用 tasks.create 而非此命令）
    "jobs.create": _jobs_create,
    "jobs.priority": lambda pos, f: call(
        "PATCH", f"/jobs/{_p0(pos, 'jobId')}/priority",
        {"priority": int(need(f.get("priority"), "--priority"))}),
    "jobs.cancel": lambda pos, f: call("POST", f"/jobs/{_p0(pos, 'jobId')}/cancel"),
    "jobs.resume": lambda pos, f: call("POST", f"/jobs/{_p0(pos, 'jobId')}/resume"),

    # ---------- 结果 ----------
    "findings.list": lambda pos, f: call(
        "GET", f"/findings?project_id={f['project']}" if f.get("project") else "/findings"),
    "canvases.list": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/canvases"),
    "canvases.get": lambda pos, f: call("GET", f"/canvases/{_p0(pos, 'canvasId')}"),

    # ---------- 任务报告（job 完成后由调度器自动生成） ----------
    "reports.get": lambda pos, f: call("GET", f"/canvases/{_p0(pos, 'canvasId')}/report"),
    "reports.markdown": lambda pos, f: call_text("GET", f"/reports/{_p0(pos, 'reportId')}/markdown"),
    "reports.sarif": lambda pos, f: call_text("GET", f"/reports/{_p0(pos, 'reportId')}/sarif"),
    "reports.retry": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/report/retry"),

    # ---------- Fact 人工验证（needs_human 的确认/排除；处理后可能推进报告） ----------
    "nodes.verify": lambda pos, f: call(
        "PATCH", f"/canvas-nodes/{_p0(pos, 'nodeId')}/verification",
        {"status": need(f.get("status"), "--status verified|rejected|needs_human"),
         **({"note": f["note"]} if f.get("note") else {})}),

    # ---------- 设置（规则默认值 / 项目覆盖 / 角色启停） ----------
    "settings.get": lambda pos, f: call("GET", "/global-settings"),
    "settings.update": lambda pos, f: call(
        "PATCH", "/global-settings",
        {"rules": parse_json_arg(need(f.get("rules"), "--rules '{...}'"), "--rules")}),
    "project-settings.get": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/settings"),
    "project-settings.update": _project_settings_update,

    # ---------- 角色注册表（name 即 job.type；kind: hub/system/role） ----------
    "roles.list": lambda pos, f: call("GET", "/agent-roles"),
    "roles.project": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/roles"),
    "roles.create": _roles_create,
    "roles.update": lambda pos, f: call(
        "PATCH", f"/agent-roles/{_p0(pos, 'roleId')}",
        parse_json_arg(need(f.get("data"), '--data \'{"title":"..."}\''), "--data")),
    "roles.delete": lambda pos, f: call("DELETE", f"/agent-roles/{_p0(pos, 'roleId')}"),

    # ---------- RoleConfig（角色 → agent 配置；全局缺省 + 项目级覆盖，声明式全量替换） ----------
    "role-configs.global": lambda pos, f: call("GET", "/role-configs/global"),
    "role-configs.global-put": lambda pos, f: call(
        "PUT", f"/role-configs/global/{_p0(pos, 'roleId')}",
        parse_json_arg(need(f.get("data"), "--data '{...}' 或 @file.json"), "--data")),
    "role-configs.list": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/role-configs"),
    "role-configs.put": lambda pos, f: call(
        "PUT", f"/projects/{_p0(pos, 'projectId')}/role-configs/{_p1(pos, 'roleId')}",
        parse_json_arg(need(f.get("data"), "--data '{...}' 或 @file.json"), "--data")),
    "role-configs.delete": lambda pos, f: call(
        "DELETE", f"/projects/{_p0(pos, 'projectId')}/role-configs/{_p1(pos, 'roleId')}"),

    # ---------- Skill 模块源（Git 托管；新源默认 quarantined，需 trust 后才下发） ----------
    "skills.list": lambda pos, f: call("GET", "/skill-sources"),
    "skills.get": lambda pos, f: call("GET", f"/skill-sources/{_p0(pos, 'sourceId')}"),
    "skills.create": _skills_create,
    "skills.sync": lambda pos, f: call("POST", f"/skill-sources/{_p0(pos, 'sourceId')}/sync"),
    "skills.trust": _skills_trust,
    "skills.delete": lambda pos, f: call("DELETE", f"/skill-sources/{_p0(pos, 'sourceId')}"),

    # ---------- Plane 集成（可选） ----------
    "plane.bind": lambda pos, f: call(
        "PUT", f"/projects/{_p0(pos, 'projectId')}/integrations/plane",
        {"plane_project_id": need(f.get("project-id"), "--project-id")}),
    "plane.unbind": lambda pos, f: call("DELETE", f"/projects/{_p0(pos, 'projectId')}/integrations/plane"),
    "plane.sync": lambda pos, f: call("POST", f"/projects/{_p0(pos, 'projectId')}/integrations/plane/sync"),
    "plane.info": lambda pos, f: call("GET", "/plane-info"),

    # ---------- Provider Credential（明文不可回读） ----------
    "credentials.list": lambda pos, f: call("GET", "/credentials"),
    "credentials.create": _credentials_create,
    "credentials.update": lambda pos, f: call(
        "PATCH", f"/credentials/{_p0(pos, 'credentialId')}",
        parse_json_arg(need(f.get("data"), '--data \'{"metadata":{"base_url":"..."}}\''), "--data")),
    "credentials.rotate": lambda pos, f: call(
        "POST", f"/credentials/{_p0(pos, 'credentialId')}/rotate",
        {"secret": need(f.get("secret"), "--secret")}),
    "credentials.status": lambda pos, f: call(
        "POST", f"/credentials/{_p0(pos, 'credentialId')}/status",
        {"status": need(f.get("status"), "--status active|disabled|rotation_required")}),
    "credentials.test": lambda pos, f: call("POST", f"/credentials/{_p0(pos, 'credentialId')}/test"),
}


def main() -> None:
    argv = sys.argv[1:]
    resource = argv[0] if argv else None
    action = argv[1] if len(argv) > 1 else None
    rest = argv[2:] if len(argv) > 2 else []
    if not resource:
        sys.stderr.write(
            f"用法: dfh-api.py <资源> <动作> [args] [--flag value]\n"
            f"先拉契约: schema openapi|summary|markdown\n"
            f"可用: {', '.join(COMMANDS)}\n"
        )
        sys.exit(64)
    # schema openapi|summary|markdown → schema 单资源 + 位置参数
    if resource == "schema" and action in (None, "openapi", "summary", "markdown", "md", "json"):
        key = "schema"
        if action:
            rest = [action, *rest]
            action = None
        else:
            key = "schema"
    else:
        key = f"{resource}.{action}" if action else resource
    fn = COMMANDS.get(key)
    if fn is None:
        sys.stderr.write(f"未知命令: {key}\n可用: {', '.join(COMMANDS)}\n")
        sys.exit(64)
    pos, flags = parse_flags(rest)
    try:
        emit(fn(pos, flags))
    except ApiError as e:
        sys.stderr.write(
            json.dumps(
                {"ok": False, "status": e.status, "error": str(e), "details": e.body},
                ensure_ascii=False,
            )
            + "\n"
        )
        sys.exit(3 if e.status in (401, 403) else 1)
    except urllib.error.URLError as e:
        sys.stderr.write(
            json.dumps({"ok": False, "status": None, "error": f"连接失败: {e.reason}", "details": None},
                       ensure_ascii=False)
            + "\n"
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
