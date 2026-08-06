#!/usr/bin/env python3
"""
DeepSonar Management API CLI（Management Skill 的脚本入口）

环境变量：
  DEEPSONAR_BASE_URL   调度器地址（默认 http://localhost:3100）
  DEEPSONAR_API_TOKEN  Platform API Token（deepsonar_<env>_<prefix>_<secret>）；auth 关闭时可省略

用法：python deepsonar-api.py <资源> <动作> [位置参数] [--flag value...]
输出：stdout 单行/多行 JSON（结构化，便于其他 Agent 消费）；错误走 stderr + 非零退出码。
      reports.markdown / reports.sarif 例外：直接输出原文（text/markdown、sarif+json）。

复杂 JSON 参数（--data / --rules / --payload）支持 "@path/to/file.json" 从文件读取。

仅依赖 Python 标准库（3.8+），无需 pip install。
"""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import sys
from typing import Dict
import urllib.error
import urllib.request

# Windows 控制台默认 GBK，强制 UTF-8 输出，保证下游 Agent 消费一致
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

BASE = (os.environ.get("DEEPSONAR_BASE_URL") or "http://localhost:3100").rstrip("/")
TOKEN = os.environ.get("DEEPSONAR_API_TOKEN") or ""


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


def _decode_json_text(text: str):
    """解析 JSON；容忍 Windows curl/部分代理带来的 UTF-8 BOM。"""
    if text is None:
        return None
    cleaned = text.lstrip("﻿").strip()
    if not cleaned:
        return None
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw": text}


def call(method: str, path: str, body=None):
    # 无 body 时不带 application/json，避免 Fastify FST_ERR_CTP_EMPTY_JSON_BODY
    headers = {}
    if TOKEN:
        headers["authorization"] = f"Bearer {TOKEN}"
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    status = 200
    try:
        with urllib.request.urlopen(req) as res:
            status = res.status
            text = res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", errors="replace")
    parsed = _decode_json_text(text)
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
            return res.read().decode("utf-8", errors="replace").lstrip("﻿")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        msg = f"HTTP {e.code}"
        try:
            msg = _decode_json_text(text).get("error") or msg
        except Exception:
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


def _settings_update(_pos, f):
    """Patch global rules, with explicit concurrency shortcuts for operators."""
    rules = {}
    if f.get("rules"):
        parsed = parse_json_arg(str(f["rules"]), "--rules")
        if not isinstance(parsed, dict):
            raise ApiError("--rules 必须是 JSON 对象")
        rules.update(parsed)
    if f.get("max-global-jobs") is not None:
        rules["maxGlobalJobs"] = int(f["max-global-jobs"])
    if f.get("max-jobs-per-project") is not None:
        rules["maxJobsPerProject"] = int(f["max-jobs-per-project"])
    if f.get("cli-limits"):
        cli_limits = parse_json_arg(str(f["cli-limits"]), "--cli-limits")
        if not isinstance(cli_limits, dict):
            raise ApiError("--cli-limits 必须是 JSON 对象")
        rules["maxConcurrentByAgentCli"] = cli_limits
    if not rules:
        raise ApiError("至少提供 --rules、--max-global-jobs、--max-jobs-per-project 或 --cli-limits")
    return call("PATCH", "/global-settings", {"rules": rules})


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
        "provider": need(
            f.get("provider"),
            "--provider anthropic|kimi|openai|openrouter|plane|git|<oci-registry-host>",
        ),
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


def _runtime_images_list(_pos, f):
    qs = []
    if f.get("search"):
        qs.append("search=" + urllib.request.quote(str(f["search"])))
    if f.get("project"):
        qs.append("project_id=" + urllib.request.quote(str(f["project"])))
    path = "/runtime-images" + (("?" + "&".join(qs)) if qs else "")
    return call("GET", path)


def _runtime_images_project_enable(pos, f):
    body = {
        "enabled": str(need(f.get("enabled"), "--enabled true|false")).lower() == "true",
    }
    if f.get("version-id"):
        body["version_id"] = f["version-id"]
    return call(
        "PUT",
        f"/projects/{_p0(pos, 'projectId')}/runtime-images/{_p1(pos, 'imageId')}",
        body,
    )


def _runtime_images_detect_local(pos, f):
    """检测当前机器已有的 Docker 镜像；只返回候选，不改变 trust 状态。"""
    image_id = _p0(pos, "imageId")
    image_ref = need(f.get("image-ref"), "--image-ref（本地 tag/ref）")
    return call("POST", f"/runtime-images/{image_id}/detect-local", {"image_ref": image_ref})


def _runtime_images_adopt_local(pos, f):
    """在管理员二次核对 image ID 后授权采用本地候选。"""
    image_id = _p0(pos, "imageId")
    image_ref = need(f.get("image-ref"), "--image-ref（本地 tag/ref）")
    expected_image_id = need(f.get("expected-image-id"), "--expected-image-id（detect-local 返回的 sha256）")
    return call(
        "POST",
        f"/runtime-images/{image_id}/adopt-local",
        {"image_ref": image_ref, "expected_image_id": expected_image_id},
    )


def _findings_list(_pos, f):
    qs = []
    if f.get("project"):
        qs.append("project_id=" + urllib.request.quote(str(f["project"])))
    if f.get("canvas"):
        qs.append("canvas_id=" + urllib.request.quote(str(f["canvas"])))
    path = "/findings" + (("?" + "&".join(qs)) if qs else "")
    return call("GET", path)


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


def _builtin_prompt_templates(schema_path: Path) -> Dict[str, str]:
    """从空库基线提取内置 RoleConfig Prompt，避免线上同步维护第二份模板。"""
    if not schema_path.is_file():
        raise ApiError(f"schema 文件不存在: {schema_path}")
    # newline="" 保留 Windows CRLF；Scheduler 基线执行时同样保留文件原字节。
    with schema_path.open("r", encoding="utf-8", newline="") as fh:
        text = fh.read()
    pairs = re.findall(
        r"\('([a-z][a-z0-9_]*)',\s*\$instructions\$(.*?)\$instructions\$\)",
        text,
        flags=re.DOTALL,
    )
    # 保留 dollar-quoted 文本的原始换行，使全新数据库与线上同步得到完全相同的 Prompt 哈希。
    templates = {name: prompt for name, prompt in pairs}
    expected = {"explore", "analyze", "review", "test", "code", "audit", "hub_reason", "verify", "report"}
    missing = sorted(expected - templates.keys())
    if missing:
        raise ApiError(f"schema 缺少内置 Prompt: {', '.join(missing)}")
    return templates


def _role_config_put_body(cfg: dict, instructions: str, disable_human: bool) -> dict:
    """把 GET view 转成声明式 PUT body；保留所有用户运行配置，只替换 Prompt。"""
    tools = dict(cfg.get("platform_tools_json") or {})
    if disable_human:
        # 兼容尚未部署新工具矩阵的实例；新版服务端会拒绝该键，调用方随后无键重试。
        tools["request_human"] = False
    return {
        "agent_cli": cfg.get("agent_cli") or "claude-code",
        "model": cfg.get("model"),
        "reasoning": cfg.get("reasoning"),
        "env_keys": cfg.get("env_keys") or [],
        "env_vars": cfg.get("env_vars_json") or {},
        "modules": cfg.get("modules_json") or [],
        "skills": cfg.get("skills_json") or [],
        "commands": cfg.get("commands_json") or [],
        "mcps": cfg.get("mcps_json") or [],
        "subagents": cfg.get("subagents_json") or [],
        "platform_tools": tools,
        "instructions_markdown": instructions,
        "runtime_image_key": cfg.get("runtime_image_key"),
        "credentials": [
            {"credential_id": item["credential_id"], "purpose": item["purpose"]}
            for item in (cfg.get("credentials") or [])
        ],
        "config_files": [
            {"path": item["path"], "content": item["content"]}
            for item in (cfg.get("config_files") or [])
        ],
    }


def _role_configs_sync_builtin_prompts(_pos, f):
    """从 database/schema.sql 同步全局内置 Prompt；不覆盖其它 RoleConfig 字段。"""
    default_schema = Path(__file__).resolve().parents[3] / "database" / "schema.sql"
    schema_path = Path(str(f.get("schema") or default_schema)).resolve()
    templates = _builtin_prompt_templates(schema_path)
    configs = call("GET", "/role-configs/global") or []
    by_name = {str(cfg.get("role_name")): cfg for cfg in configs}
    missing_online = sorted(set(templates) - set(by_name))
    if missing_online:
        raise ApiError(f"线上缺少全局内置 RoleConfig: {', '.join(missing_online)}")

    dry_run = bool(f.get("dry-run"))
    results = []
    for role_name, instructions in templates.items():
        cfg = by_name[role_name]
        before = str(cfg.get("instructions_markdown") or "")
        changed = before != instructions
        disable_human = role_name in {"verify", "report"}
        body = _role_config_put_body(cfg, instructions, disable_human=disable_human)
        if not dry_run and (changed or disable_human):
            role_id = need(cfg.get("role_id"), f"线上 {role_name}.role_id")
            try:
                call("PUT", f"/role-configs/global/{role_id}", body)
            except ApiError as error:
                # 新版服务端已从 verify/report 合法工具集中移除 request_human；去掉兼容键重试。
                if disable_human and error.status == 400 and "request_human" in str(error):
                    body["platform_tools"].pop("request_human", None)
                    call("PUT", f"/role-configs/global/{role_id}", body)
                else:
                    raise
        results.append({
            "role": role_name,
            "changed": changed,
            "current_prompt_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
            "prompt_sha256": hashlib.sha256(instructions.encode("utf-8")).hexdigest(),
            "request_human_disabled": disable_human,
        })
    return {"ok": True, "dry_run": dry_run, "schema": str(schema_path), "roles": results}


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
    "findings.list": _findings_list,
    "findings.get": lambda pos, f: call("GET", f"/findings/{_p0(pos, 'findingId')}"),
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
    "settings.update": _settings_update,
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

    # ---------- RoleConfig（全局缺省 + 项目覆盖；轻量 PATCH 供 Provider 绑定流） ----------
    # PUT body 可含 runtime_image_key（官方 catalog 可写；null=系统底座）、credentials[].purpose 用 llm
    "role-configs.global": lambda pos, f: call("GET", "/role-configs/global"),
    "role-configs.global-put": lambda pos, f: call(
        "PUT", f"/role-configs/global/{_p0(pos, 'roleId')}",
        parse_json_arg(need(f.get("data"), "--data '{...}' 或 @file.json"), "--data")),
    "role-configs.bindable": lambda pos, f: call("GET", "/role-configs/bindable"),
    "role-configs.agent-cli": lambda pos, f: call(
        "PATCH", f"/role-configs/{_p0(pos, 'roleConfigId')}/agent-cli",
        {"agent_cli": need(f.get("agent-cli") or f.get("cli"), "--agent-cli claude-code|codex|open-code")}),
    "role-configs.runtime-image": lambda pos, f: call(
        "PATCH", f"/role-configs/{_p0(pos, 'roleConfigId')}/runtime-image",
        {"runtime_image_key": (
            None if (f.get("image-key") in (None, "", "null", "base", "system"))
            else f.get("image-key")
        )}),
    "role-configs.sync-builtin-prompts": _role_configs_sync_builtin_prompts,
    "role-configs.list": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/role-configs"),
    "role-configs.put": lambda pos, f: call(
        "PUT", f"/projects/{_p0(pos, 'projectId')}/role-configs/{_p1(pos, 'roleId')}",
        parse_json_arg(need(f.get("data"), "--data '{...}' 或 @file.json"), "--data")),
    "role-configs.delete": lambda pos, f: call(
        "DELETE", f"/projects/{_p0(pos, 'projectId')}/role-configs/{_p1(pos, 'roleId')}"),

    # ---------- 运行时镜像市场（tag 不可信；Job 只冻结 digest） ----------
    "runtime-images.list": _runtime_images_list,
    "runtime-images.get": lambda pos, f: call("GET", f"/runtime-images/{_p0(pos, 'imageId')}"),
    "runtime-images.import": lambda pos, f: call(
        "POST", "/runtime-images/import",
        parse_json_arg(need(f.get("data"), "--data '{image_key,name,publisher,image_ref,...}'"), "--data")),
    "runtime-images.rescan": lambda pos, f: call(
        "POST", f"/runtime-image-versions/{_p0(pos, 'versionId')}/rescan"),
    "runtime-images.status": lambda pos, f: call(
        "POST", f"/runtime-image-versions/{_p0(pos, 'versionId')}/status",
        {"status": need(f.get("status"), "--status trusted|rejected|disabled|revoked"),
         **({"reason": f["reason"]} if f.get("reason") else {})}),
    "runtime-images.usage": lambda pos, f: call(
        "GET", f"/runtime-image-versions/{_p0(pos, 'versionId')}/usage"),
    "runtime-images.project-enable": _runtime_images_project_enable,
    "runtime-images.detect-local": _runtime_images_detect_local,
    "runtime-images.adopt-local": _runtime_images_adopt_local,

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

    # ---------- Provider / OCI Credential（明文不可回读） ----------
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
    # 无 body；用于 RoleConfig 选 model 前发现 Provider 真实目录
    "credentials.models": lambda pos, f: call("POST", f"/credentials/{_p0(pos, 'credentialId')}/models"),
}


def main() -> None:
    argv = sys.argv[1:]
    resource = argv[0] if argv else None
    action = argv[1] if len(argv) > 1 else None
    rest = argv[2:] if len(argv) > 2 else []
    if not resource:
        sys.stderr.write(
            f"用法: deepsonar-api.py <资源> <动作> [args] [--flag value]\n"
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
