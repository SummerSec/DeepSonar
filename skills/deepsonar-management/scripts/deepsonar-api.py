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
import urllib.parse
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


def call_bytes(method: str, path: str, data: bytes | None = None, content_type: str | None = None,
               extra_headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
    """Call a binary endpoint without decoding or printing the response body."""
    headers: dict[str, str] = {}
    if TOKEN:
        headers["authorization"] = f"Bearer {TOKEN}"
    if content_type:
        headers["content-type"] = content_type
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            return res.read(), {str(k).lower(): str(v) for k, v in res.headers.items()}
    except urllib.error.HTTPError as e:
        raw = e.read()
        parsed = _decode_json_text(raw.decode("utf-8", errors="replace"))
        msg = (parsed or {}).get("error") or (parsed or {}).get("message") or f"HTTP {e.code}"
        raise ApiError(msg if isinstance(msg, str) else f"HTTP {e.code}", status=e.code, body=parsed)


def query_path(path: str, values: dict[str, object | None]) -> str:
    """Append non-empty query values using URL encoding."""
    pairs = [(key, str(value)) for key, value in values.items() if value is not None and value != ""]
    return path + (("?" + urllib.parse.urlencode(pairs)) if pairs else "")


def parse_bool(value, name: str) -> bool:
    normalized = str(need(value, name)).lower()
    if normalized not in ("true", "false"):
        raise ApiError(f"{name} 必须是 true 或 false")
    return normalized == "true"


def parse_list_arg(value, name: str) -> list[str]:
    """Accept a JSON string array, @file, or a comma-separated list."""
    raw = need(value, name)
    if str(raw).startswith("[") or str(raw).startswith("@"):
        parsed = parse_json_arg(str(raw), name)
        if not isinstance(parsed, list) or any(not isinstance(item, str) or not item.strip() for item in parsed):
            raise ApiError(f"{name} 必须是字符串数组")
        return [item.strip() for item in parsed]
    return [item.strip() for item in str(raw).split(",") if item.strip()]


def read_file_bytes(value, name: str) -> bytes:
    path = Path(need(value, name))
    if not path.is_file():
        raise ApiError(f"{name} 文件不存在: {path}")
    try:
        return path.read_bytes()
    except OSError as error:
        raise ApiError(f"{name} 文件读取失败: {error}")


def download_to(path: str, f: dict, default_name: str) -> dict:
    """Download a non-JSON endpoint to an explicit local path."""
    output = Path(str(f.get("out") or default_name)).expanduser()
    body, headers = call_bytes("GET", path)
    try:
        output.write_bytes(body)
    except OSError as error:
        raise ApiError(f"--out 写入失败: {error}")
    return {
        "ok": True,
        "path": str(output.resolve()),
        "bytes": len(body),
        "content_type": headers.get("content-type"),
        "sha256": hashlib.sha256(body).hexdigest(),
    }


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
    kind = str(f.get("kind") or "standard")
    if kind not in ("standard", "compose"):
        raise ApiError("--kind 必须是 standard 或 compose")
    body = {"title": title, "content": content, "kind": kind}
    if f.get("seed-finding-ids") is not None:
        body["seed_finding_ids"] = parse_list_arg(f["seed-finding-ids"], "--seed-finding-ids")
    if kind == "standard" and body.get("seed_finding_ids"):
        raise ApiError("standard 任务禁止携带 --seed-finding-ids")
    if kind == "compose" and not body.get("seed_finding_ids"):
        raise ApiError("compose 任务必须提供 --seed-finding-ids")
    if f.get("allow-egress") is not None:
        body["allow_egress"] = parse_bool(f["allow-egress"], "--allow-egress")
    if f.get("finding-protocol"):
        body["finding_protocol"] = parse_json_arg(str(f["finding-protocol"]), "--finding-protocol")
    if f.get("scheduled-start-at"):
        body["scheduled_start_at"] = f["scheduled-start-at"]
    if f.get("schedule-beijing-8am") is not None:
        body["schedule_beijing_8am"] = parse_bool(f["schedule-beijing-8am"], "--schedule-beijing-8am")
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
    if f.get("finding-protocol"):
        body["finding_protocol"] = parse_json_arg(str(f["finding-protocol"]), "--finding-protocol")
    if not body:
        raise ApiError("至少提供 --rules、--roles 或 --finding-protocol")
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
    if f.get("max-concurrent-provisioning") is not None:
        rules["maxConcurrentProvisioning"] = int(f["max-concurrent-provisioning"])
    if f.get("cli-limits"):
        cli_limits = parse_json_arg(str(f["cli-limits"]), "--cli-limits")
        if not isinstance(cli_limits, dict):
            raise ApiError("--cli-limits 必须是 JSON 对象")
        rules["maxConcurrentByAgentCli"] = cli_limits
    body = {"rules": rules} if rules else {}
    if f.get("finding-protocol"):
        body["finding_protocol"] = parse_json_arg(str(f["finding-protocol"]), "--finding-protocol")
    if not body:
        raise ApiError("至少提供 --rules、--finding-protocol、--max-global-jobs、--max-jobs-per-project、--max-concurrent-provisioning 或 --cli-limits")
    return call("PATCH", "/global-settings", body)


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
        body["enabled"] = parse_bool(f["enabled"], "--enabled")
    sid = need(pos[0] if pos else None, "sourceId")
    return call("POST", f"/skill-sources/{sid}/trust", body)


def _credentials_create(_pos, f):
    body = {
        "name": need(f.get("name"), "--name"),
        "provider": need(
            f.get("provider"),
            "--provider anthropic|openai|plane|git|<oci-registry-host>",
        ),
        "secret": need(f.get("secret"), "--secret"),
    }
    if f.get("kind"):
        body["kind"] = f["kind"]
    if f.get("project-id"):
        body["project_id"] = f["project-id"]
    if f.get("agent-cli"):
        body["agent_cli"] = f["agent-cli"]
    if f.get("settings-config"):
        body["settings_config"] = parse_json_arg(str(f["settings-config"]), "--settings-config")
    meta = {}
    if f.get("base-url"):
        meta["base_url"] = str(f["base-url"]).rstrip("/")
    if f.get("metadata"):
        meta.update(parse_json_arg(str(f["metadata"]), "--metadata"))
    if meta:
        body["metadata"] = meta
    if f.get("meta"):
        body["meta"] = parse_json_arg(str(f["meta"]), "--meta")
    return call("POST", "/credentials", body)


def _credentials_models_preview(_pos, f):
    body = {
        "agent_cli": need(f.get("agent-cli"), "--agent-cli claude-code|codex|open-code|pi|dsh"),
        "provider": need(f.get("provider"), "--provider anthropic|openai"),
        "secret": need(f.get("secret"), "--secret"),
    }
    if f.get("base-url"):
        body["base_url"] = str(f["base-url"]).rstrip("/")
    if f.get("settings-config"):
        body["settings_config"] = parse_json_arg(str(f["settings-config"]), "--settings-config")
    if f.get("metadata"):
        body["metadata"] = parse_json_arg(str(f["metadata"]), "--metadata")
    return call("POST", "/credentials/models/preview", body)


def _credentials_update(pos, f):
    body = parse_json_arg(str(need(f.get("data"), "--data '{...}' 或 @file.json")), "--data")
    if not isinstance(body, dict):
        raise ApiError("--data 必须是 JSON 对象")
    return call("PATCH", f"/credentials/{_p0(pos, 'credentialId')}", body)


def _credentials_compatibility(pos, f):
    path = query_path(f"/credentials/{_p0(pos, 'credentialId')}/compatibility", {
        "agent_cli": f.get("agent-cli") or f.get("cli"),
        "model": f.get("model"),
    })
    return call("GET", path)


def _credentials_batch_bind(_pos, f):
    body = {
        "credential_id": need(f.get("credential-id"), "--credential-id"),
        "role_config_ids": parse_list_arg(f.get("role-config-ids"), "--role-config-ids"),
        "mode": f.get("mode") or "bind",
        "effect": f.get("effect") or "new_jobs_only",
        "idempotency_key": need(f.get("idempotency-key"), "--idempotency-key（至少 8 个字符）"),
    }
    if f.get("source-credential-id"):
        body["source_credential_id"] = f["source-credential-id"]
    if f.get("model") is not None:
        body["model"] = f["model"]
    return call("POST", "/credentials/batch-bind", body)

def _runtime_images_list(_pos, f):
    return call("GET", query_path("/runtime-images", {
        "search": f.get("search"),
        "project_id": f.get("project"),
    }))


def _readiness(pos, f):
    path = "/readiness" if not pos else f"/projects/{_p0(pos, 'projectId')}/readiness"
    allow_egress = None
    if f.get("allow-egress") is not None:
        allow_egress = "true" if parse_bool(f["allow-egress"], "--allow-egress") else "false"
    return call("GET", query_path(path, {
        "allow_egress": allow_egress,
        "material_source": f.get("material-source"),
    }))


def _runtime_registry_apply(_pos, f):
    return call("POST", "/runtime-images/registry/apply",
                parse_json_arg(str(need(f.get("data"), "--data @runtime-image-registry.json")), "--data"))


def _runtime_registry_channel(_pos, f):
    return call("PATCH", "/runtime-images/registry/channel", {
        "channel": need(f.get("channel"), "--channel github|dockerhub|aliyun-acr"),
    })


def _runtime_images_official_digest(pos, f):
    body = {"image_ref": need(f.get("image-ref"), "--image-ref")}
    if f.get("version"):
        body["version"] = f["version"]
    if f.get("source"):
        body["source"] = f["source"]
    return call("POST", f"/runtime-images/{_p0(pos, 'imageId')}/official-digest", body)


def _runtime_images_manual_digest(_pos, f):
    body = {
        "image_key": need(f.get("image-key"), "--image-key"),
        "name": need(f.get("name"), "--name"),
        "publisher": need(f.get("publisher"), "--publisher"),
        "image_ref": need(f.get("image-ref"), "--image-ref name@sha256:..."),
    }
    for key in ("description", "source-url", "version"):
        if f.get(key):
            body[key.replace("-", "_")] = f[key]
    return call("POST", "/runtime-images/manual-digest", body)


def _runtime_images_project_enable(pos, f):
    body = {
        "enabled": parse_bool(f.get("enabled"), "--enabled"),
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


def _facts_list(pos, f):
    return call("GET", query_path(
        f"/canvases/{need(pos[0] if pos else None, 'canvasId')}/facts",
        {
            "limit": f.get("limit"),
            "after": f.get("after"),
            "verification_status": f.get("verification-status"),
            "evidence_kind": f.get("evidence-kind"),
            "finding_id": f.get("finding-id"),
            "job_id": f.get("job-id"),
        },
    ))


def _facts_verify(pos, f):
    body = {"status": need(f.get("status"), "--status verified|rejected|needs_human")}
    if f.get("note"):
        body["note"] = f["note"]
    canvas_id = need(pos[0] if pos else None, "canvasId")
    node_id = need(pos[1] if len(pos) > 1 else None, "nodeId")
    return call("PATCH", f"/canvases/{canvas_id}/facts/{node_id}/verification", body)


def _canvas_message_send(pos, f):
    target_kind = str(need(f.get("target-kind"), "--target-kind hub|job"))
    if target_kind not in ("hub", "job"):
        raise ApiError("--target-kind 必须是 hub 或 job")
    target = {"kind": target_kind}
    if target_kind == "job":
        target["node_id"] = need(f.get("target-node-id"), "--target-node-id")
    body = {
        "message_id": need(f.get("message-id"), "--message-id UUID"),
        "target": target,
        "body": need(f.get("body"), "--body"),
        "attachment_version_ids": parse_list_arg(f["attachment-version-ids"], "--attachment-version-ids")
        if f.get("attachment-version-ids") else [],
    }
    return call("POST", f"/canvases/{need(pos[0] if pos else None, 'canvasId')}/messages", body)


def _findings_list(_pos, f):
    return call("GET", query_path("/findings", {
        "project_id": f.get("project"),
        "canvas_id": f.get("canvas"),
        "severity": f.get("severity"),
        "profile": f.get("profile"),
        "category": f.get("category"),
        "verify_status": f.get("verify-status"),
        "disposition": f.get("disposition"),
        "cursor": f.get("cursor") or f.get("after"),
        "limit": f.get("limit"),
    }))


def _findings_disposition(pos, f):
    body = {"disposition": need(f.get("disposition"), "--disposition")}
    if f.get("note"):
        body["note"] = f["note"]
    return call("PATCH", f"/findings/{_p0(pos, 'findingId')}/disposition", body)


def _findings_comment(pos, f):
    body = {
        "body": need(f.get("body"), "--body"),
        "request_hub": parse_bool(f.get("request-hub"), "--request-hub") if f.get("request-hub") is not None else True,
    }
    return call("POST", f"/findings/{_p0(pos, 'findingId')}/comments", body)


def _findings_link(pos, f):
    body = {
        "url": need(f.get("url"), "--url"),
        "link_type": f.get("link-type") or "related",
    }
    if f.get("title"):
        body["title"] = f["title"]
    return call("POST", f"/findings/{_p0(pos, 'findingId')}/links", body)


def _asset_list(path: str, f):
    return call("GET", query_path(path, {
        "limit": f.get("limit"),
        "offset": f.get("offset"),
    }))


def _asset_upload(path: str, f):
    content_type = str(f.get("content-type") or "application/octet-stream")
    extra = {"x-asset-key": need(f.get("asset-key"), "--asset-key")}
    if f.get("asset-content-type"):
        extra["x-asset-content-type"] = str(f["asset-content-type"])
    if f.get("labels"):
        labels = parse_json_arg(str(f["labels"]), "--labels")
        if not isinstance(labels, dict):
            raise ApiError("--labels 必须是 JSON 对象")
        extra["x-asset-labels"] = json.dumps(labels, ensure_ascii=False, separators=(",", ":"))
    raw, _ = call_bytes("POST", path, read_file_bytes(f.get("file"), "--file"), content_type, extra)
    return _decode_json_text(raw.decode("utf-8", errors="replace"))


def _asset_archive(pos, _f):
    return call("POST", f"/shared-assets/{_p0(pos, 'assetId')}/archive")


def _asset_download(pos, f):
    return download_to(f"/shared-assets/{_p0(pos, 'assetId')}/content", f, "asset.bin")


def _assets_policy_update(pos, f):
    return call("PATCH", f"/projects/{_p0(pos, 'projectId')}/shared-assets/policy", {
        "platform_enabled": parse_bool(f.get("platform-enabled"), "--platform-enabled"),
    })


def _jobs_list(_pos, f):
    return call("GET", query_path("/jobs", {
        "project_id": f.get("project"),
        "status": f.get("status"),
        "canvas_id": f.get("canvas"),
        "cursor": f.get("cursor") or f.get("after"),
        "limit": f.get("limit"),
    }))


def _jobs_events(pos, f):
    return call("GET", query_path(f"/jobs/{_p0(pos, 'jobId')}/events", {
        "cursor": f.get("cursor") or f.get("after"),
        "limit": f.get("limit"),
    }))


def _jobs_evidence_stream(pos, f):
    tail = None
    if f.get("tail") is not None:
        tail = "true" if parse_bool(f["tail"], "--tail") else "false"
    return call("GET", query_path(f"/jobs/{_p0(pos, 'jobId')}/evidence/stream", {
        "cursor": f.get("cursor") or f.get("after"),
        "limit": f.get("limit"),
        "tail": tail,
    }))


def _jobs_cancel(pos, f):
    body = {}
    if f.get("force") is not None:
        body["force"] = parse_bool(f["force"], "--force")
    if f.get("reason"):
        body["reason"] = f["reason"]
    return call("POST", f"/jobs/{_p0(pos, 'jobId')}/cancel", body or None)


def _jobs_cancel_active(pos, f):
    body = {"reason": f["reason"]} if f.get("reason") else None
    return call("POST", f"/canvases/{_p0(pos, 'canvasId')}/jobs/cancel-active", body)


def _binary_upload(path: str, f, content_type: str) -> object:
    raw, _ = call_bytes("POST", path, read_file_bytes(f.get("file"), "--file"), content_type)
    return _decode_json_text(raw.decode("utf-8", errors="replace"))


def _export_body(f, platform: bool) -> dict:
    body = {"preset": f.get("preset") or ("platform_full" if platform else "configuration")}
    if f.get("modules"):
        body["modules"] = parse_list_arg(f["modules"], "--modules")
    if f.get("include-blobs") is not None:
        body["include_blobs"] = parse_bool(f["include-blobs"], "--include-blobs")
    if f.get("allow-active-jobs") is not None:
        body["allow_active_jobs"] = parse_bool(f["allow-active-jobs"], "--allow-active-jobs")
    if f.get("credentials-mode"):
        body["credentials"] = {"mode": f["credentials-mode"]}
    return body


def _exports_create(_pos, f):
    project_id = f.get("project-id")
    if project_id:
        return call("POST", f"/projects/{project_id}/exports", _export_body(f, platform=False))
    return call("POST", "/platform/exports", _export_body(f, platform=True))


def _exports_list(_pos, f):
    project_id = f.get("project-id")
    path = f"/projects/{project_id}/exports" if project_id else "/platform/exports"
    return call("GET", path)


def _exports_download(pos, f):
    return download_to(f"/exports/{_p0(pos, 'exportId')}/download", f, "deepsonar.deepsonarpack")


def _imports_upload(_pos, f):
    return _binary_upload("/imports", f, "application/x-deepsonarpack")


def _imports_apply(pos, f):
    body = {}
    for flag, key in (("mode", "mode"), ("project-name", "project_name"), ("target-project-id", "target_project_id"), ("conflict-policy", "conflict_policy")):
        if f.get(flag):
            body[key] = f[flag]
    if f.get("modules"):
        body["modules"] = parse_list_arg(f["modules"], "--modules")
    if f.get("credential-mappings"):
        mappings = parse_json_arg(str(f["credential-mappings"]), "--credential-mappings")
        if not isinstance(mappings, dict):
            raise ApiError("--credential-mappings 必须是 JSON 对象")
        body["credential_mappings"] = mappings
    return call("POST", f"/imports/{_p0(pos, 'importId')}/apply", body)


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


def _role_config_put_body(cfg: dict, instructions: str) -> dict:
    """把 GET view 转成声明式 PUT body；保留所有用户运行配置，只替换 Prompt。"""
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
        "platform_tools": dict(cfg.get("platform_tools_json") or {}),
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
        body = _role_config_put_body(cfg, instructions)
        if not dry_run and changed:
            role_id = need(cfg.get("role_id"), f"线上 {role_name}.role_id")
            call("PUT", f"/role-configs/global/{role_id}", body)
        results.append({
            "role": role_name,
            "changed": changed,
            "current_prompt_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
            "prompt_sha256": hashlib.sha256(instructions.encode("utf-8")).hexdigest(),
        })
    return {"ok": True, "dry_run": dry_run, "schema": str(schema_path), "roles": results}


def _p0(pos, name):
    return need(pos[0] if len(pos) > 0 else None, name)


def _p1(pos, name):
    return need(pos[1] if len(pos) > 1 else None, name)


def print_help(prefix: str | None = None) -> None:
    keys = sorted(
        key for key in COMMANDS
        if prefix is None or key == prefix or key.startswith(prefix + ".")
    )
    if prefix and not keys:
        keys = [prefix]
    sys.stdout.write(
        "用法: deepsonar-api.py <资源> <动作> [位置参数] [--flag value...]\n"
        "先拉契约: schema openapi|summary|markdown\n"
        + (f"命令前缀 {prefix}:\n" if prefix else "可用命令:\n")
        + "".join(f"  {key}\n" for key in keys)
    )


COMMANDS = {
    "health": lambda pos, f: call("GET", "/health"),

    # ---------- API Schema（豁免鉴权；以运行中调度器为准） ----------
    "schema": _schema_cmd,
    "schema.openapi": lambda pos, f: call("GET", "/openapi.json"),
    "schema.summary": lambda pos, f: call("GET", "/schema?format=summary"),
    "schema.markdown": lambda pos, f: call_text("GET", "/schema.md"),

    # ---------- 项目 ----------
    "projects.list": lambda pos, f: call("GET", "/projects"),
    "projects.sync": lambda pos, f: call("POST", "/projects/sync", {
        "plane_project_id": need(f.get("plane-project-id"), "--plane-project-id"),
        "name": need(f.get("name"), "--name"),
        "config": parse_json_arg(str(f.get("config") or "{}"), "--config"),
    }),
    "projects.get": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}"),
    "projects.create": _projects_create,
    # 服务端仅允许 name / description / status（active|archived）
    "projects.update": lambda pos, f: call(
        "PATCH", f"/projects/{_p0(pos, 'projectId')}",
        parse_json_arg(need(f.get("data"), "--data '{\"k\":\"v\"}'"), "--data")),
    "projects.archive": lambda pos, f: call("POST", f"/projects/{_p0(pos, 'projectId')}/archive"),

    # ---------- Readiness / shared assets ----------
    "readiness": _readiness,
    "readiness.project": _readiness,
    "assets.project-list": lambda pos, f: _asset_list(f"/projects/{_p0(pos, 'projectId')}/shared-assets", f),
    "assets.project-upload": lambda pos, f: _asset_upload(f"/projects/{_p0(pos, 'projectId')}/shared-assets", f),
    "assets.finding-list": lambda pos, f: _asset_list(f"/findings/{_p0(pos, 'findingId')}/shared-assets", f),
    "assets.finding-upload": lambda pos, f: _asset_upload(f"/findings/{_p0(pos, 'findingId')}/shared-assets", f),
    "assets.platform-list": lambda pos, f: _asset_list("/platform/shared-assets", f),
    "assets.platform-upload": lambda pos, f: _asset_upload("/platform/shared-assets", f),
    "assets.archive": _asset_archive,
    "assets.download": _asset_download,
    "assets.project-policy": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/shared-assets/policy"),
    "assets.project-policy-update": _assets_policy_update,

    # ---------- 任务（一次任务 = 一个画布） ----------
    "tasks.create": _tasks_create,
    "tasks.resume-session": lambda pos, f: call("POST", f"/tasks/{_p0(pos, 'canvasId')}/resume-session"),
    "tasks.retry": lambda pos, f: call("POST", f"/tasks/{_p0(pos, 'canvasId')}/retry"),
    "tasks.archive": lambda pos, f: call("POST", f"/tasks/{_p0(pos, 'canvasId')}/archive"),
    "tasks.unarchive": lambda pos, f: call("POST", f"/tasks/{_p0(pos, 'canvasId')}/unarchive"),
    "tasks.delete": lambda pos, f: call("DELETE", f"/tasks/{_p0(pos, 'canvasId')}"),

    # ---------- 事件注入（幂等：source + event_id） ----------
    "events.push": _events_push,

    # ---------- Job ----------
    "jobs.list": _jobs_list,
    "jobs.get": lambda pos, f: call("GET", f"/jobs/{_p0(pos, 'jobId')}"),
    "jobs.events": _jobs_events,
    "jobs.evidence": lambda pos, f: call("GET", f"/jobs/{_p0(pos, 'jobId')}/evidence"),
    "jobs.evidence-session": lambda pos, f: call("GET", f"/jobs/{_p0(pos, 'jobId')}/evidence/session"),
    "jobs.evidence-session-download": lambda pos, f: download_to(
        f"/jobs/{_p0(pos, 'jobId')}/evidence/session/download", f, "session.ndjson"),
    "jobs.evidence-stream": _jobs_evidence_stream,
    # 直接建 job（type 须为已注册 agent_roles.name 或系统类型；一般用 tasks.create 而非此命令）
    "jobs.create": _jobs_create,
    "jobs.priority": lambda pos, f: call(
        "PATCH", f"/jobs/{_p0(pos, 'jobId')}/priority",
        {"priority": int(need(f.get("priority"), "--priority"))}),
    "jobs.cancel": _jobs_cancel,
    "jobs.cancel-active": _jobs_cancel_active,
    "jobs.resume": lambda pos, f: call("POST", f"/jobs/{_p0(pos, 'jobId')}/resume"),

    # ---------- 结果 ----------
    "findings.list": _findings_list,
    "findings.get": lambda pos, f: call("GET", f"/findings/{_p0(pos, 'findingId')}"),
    "findings.disposition": _findings_disposition,
    "findings.comment": _findings_comment,
    "findings.comment-delete": lambda pos, f: call(
        "DELETE", f"/findings/{_p0(pos, 'findingId')}/comments/{_p1(pos, 'commentId')}"),
    "findings.link": _findings_link,
    "findings.link-delete": lambda pos, f: call(
        "DELETE", f"/findings/{_p0(pos, 'findingId')}/links/{_p1(pos, 'linkId')}"),
    "canvases.list": lambda pos, f: call("GET", f"/projects/{_p0(pos, 'projectId')}/canvases"),
    "canvases.get": lambda pos, f: call("GET", f"/canvases/{_p0(pos, 'canvasId')}"),
    "canvases.summary": lambda pos, f: call("GET", f"/canvases/{_p0(pos, 'canvasId')}/summary"),
    "canvases.delta": lambda pos, f: call("GET", query_path(
        f"/canvases/{_p0(pos, 'canvasId')}/delta", {"since": f.get("since")})),
    "canvases.node": lambda pos, f: call(
        "GET", f"/canvases/{_p0(pos, 'canvasId')}/nodes/{_p1(pos, 'nodeId')}"),
    "canvases.broadcasts": lambda pos, f: call("GET", query_path(
        f"/canvases/{_p0(pos, 'canvasId')}/broadcasts", {"limit": f.get("limit")})),
    "messages.list": lambda pos, f: call("GET", query_path(
        f"/canvases/{_p0(pos, 'canvasId')}/messages", {"limit": f.get("limit")})),
    "messages.send": _canvas_message_send,
    "facts.list": _facts_list,
    "facts.get": lambda pos, f: call(
        "GET", f"/canvases/{_p0(pos, 'canvasId')}/facts/{_p1(pos, 'nodeId')}"),
    "facts.verify": _facts_verify,
    "canvases.convergence": lambda pos, f: call("GET", f"/canvases/{_p0(pos, 'canvasId')}/convergence"),
    "canvases.pause": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/convergence/pause",
                                             {"reason": f["reason"]} if f.get("reason") else None),
    "canvases.resume": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/convergence/resume",
                                             {"force_hub": parse_bool(f["force-hub"], "--force-hub")} if f.get("force-hub") is not None else None),
    "canvases.stop-after-gate": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/convergence/stop-after-gate"),
    "canvases.drain-priority": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/convergence/drain-priority"),
    "canvases.run-hub-now": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/convergence/run-hub-now"),

    # ---------- 任务报告（job 完成后由调度器自动生成） ----------
    "reports.get": lambda pos, f: call("GET", f"/canvases/{_p0(pos, 'canvasId')}/report"),
    "reports.finding": lambda pos, f: call("GET", f"/findings/{_p0(pos, 'findingId')}/report"),
    "reports.finding-create": lambda pos, f: call("POST", f"/findings/{_p0(pos, 'findingId')}/report"),
    "reports.markdown": lambda pos, f: call_text("GET", f"/reports/{_p0(pos, 'reportId')}/markdown"),
    "reports.sarif": lambda pos, f: call_text("GET", f"/reports/{_p0(pos, 'reportId')}/sarif"),
    "reports.retry": lambda pos, f: call("POST", f"/canvases/{_p0(pos, 'canvasId')}/report/retry"),

    # ---------- 项目/平台数据包 transfer ----------
    "exports.create": _exports_create,
    "exports.list": _exports_list,
    "exports.get": lambda pos, f: call("GET", f"/exports/{_p0(pos, 'exportId')}"),
    "exports.download": _exports_download,
    "exports.cancel": lambda pos, f: call("POST", f"/exports/{_p0(pos, 'exportId')}/cancel"),
    "exports.delete": lambda pos, f: call("DELETE", f"/exports/{_p0(pos, 'exportId')}"),
    "imports.upload": _imports_upload,
    "imports.get": lambda pos, f: call("GET", f"/imports/{_p0(pos, 'importId')}"),
    "imports.preview": lambda pos, f: call("POST", f"/imports/{_p0(pos, 'importId')}/preview"),
    "imports.apply": _imports_apply,
    "imports.cancel": lambda pos, f: call("POST", f"/imports/{_p0(pos, 'importId')}/cancel"),
    "imports.delete": lambda pos, f: call("DELETE", f"/imports/{_p0(pos, 'importId')}"),

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
        {"agent_cli": need(f.get("agent-cli") or f.get("cli"), "--agent-cli claude-code|codex|open-code|pi|dsh")}),
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
    "runtime-images.registry": lambda pos, f: call("GET", "/runtime-images/registry"),
    "runtime-images.registry-channel": _runtime_registry_channel,
    "runtime-images.registry-sync": lambda pos, f: call("POST", "/runtime-images/registry/sync"),
    "runtime-images.registry-apply": _runtime_registry_apply,
    "runtime-images.registry-pull": lambda pos, f: call("POST", "/runtime-images/registry/pull"),
    "runtime-images.registry-pull-status": lambda pos, f: call("GET", "/runtime-images/registry/pull-status"),
    "runtime-images.official-digest": _runtime_images_official_digest,
    "runtime-images.manual-digest": _runtime_images_manual_digest,

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
    "credentials.providers": lambda pos, f: call("GET", "/credentials/providers"),
    "credentials.get": lambda pos, f: call("GET", f"/credentials/{_p0(pos, 'credentialId')}"),
    "credentials.impact": lambda pos, f: call("GET", f"/credentials/{_p0(pos, 'credentialId')}/impact"),
    "credentials.create": _credentials_create,
    "credentials.update": _credentials_update,
    "credentials.rotate": lambda pos, f: call(
        "POST", f"/credentials/{_p0(pos, 'credentialId')}/rotate",
        {"secret": need(f.get("secret"), "--secret")}),
    "credentials.status": lambda pos, f: call(
        "POST", f"/credentials/{_p0(pos, 'credentialId')}/status",
        {"status": need(f.get("status"), "--status active|disabled|rotation_required")}),
    "credentials.delete": lambda pos, f: call(
        "DELETE",
        query_path(f"/credentials/{_p0(pos, 'credentialId')}", {
            "unbind": "true" if f.get("unbind") in (True, "true", "1") else None,
        })),
    "credentials.test": lambda pos, f: call("POST", f"/credentials/{_p0(pos, 'credentialId')}/test"),
    # 无 body；用于 RoleConfig 选 model 前发现 Provider 真实目录
    "credentials.models": lambda pos, f: call("GET", f"/credentials/{_p0(pos, 'credentialId')}/models"),
    "credentials.models-refresh": lambda pos, f: call("POST", f"/credentials/{_p0(pos, 'credentialId')}/models"),
    "credentials.compatibility": _credentials_compatibility,
    "credentials.batch-bind": _credentials_batch_bind,
    "credentials.models-preview": _credentials_models_preview,
}


def main() -> None:
    argv = sys.argv[1:]
    if not argv or argv == ["--help"]:
        print_help()
        return
    if "--help" in argv:
        prefix = argv[0]
        if len(argv) > 1 and argv[1] != "--help":
            prefix = f"{argv[0]}.{argv[1]}"
        print_help(prefix)
        return
    resource = argv[0] if argv else None
    action = argv[1] if len(argv) > 1 else None
    rest = argv[2:] if len(argv) > 2 else []
    if not resource:
        print_help()
        return
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
        sys.stderr.write(f"未知命令: {key}\n")
        print_help(resource)
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
