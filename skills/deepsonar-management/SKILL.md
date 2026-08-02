---
name: deepsonar-management
description: 通过 DeepSonar API 管理调度平台：先拉 OpenAPI/schema 再操作；项目/任务/Job 生命周期，画布/Finding/报告，RoleConfig（模型 ID/思考强度）、Skill 模块源、凭据、Plane。当需要以程序化方式操作 DeepSonar 时使用。
---

# DeepSonar Management

让外部 Agent（Codex / Claude Code / CI）通过最小权限 API Token 管理 DeepSonar，
不依赖浏览器。除报告下载与 Markdown schema 外，动作输出结构化 JSON（stdout）。

## 使用方式

```bash
export DEEPSONAR_BASE_URL=http://localhost:3100
export DEEPSONAR_API_TOKEN=deepsonar_dev_xxxxxxxx_xxxxxxxx   # 见 references/permissions.md

python scripts/deepsonar-api.py <command> [args...] [--flag value...]
```

复杂 JSON（`--data` / `--rules` / `--payload`）可内联，或 `@path/to/file.json`。

### 0. 先拉最新 schema（推荐，豁免鉴权）

契约以**运行中调度器**为准，不要只依赖本仓库静态文档：

```bash
python scripts/deepsonar-api.py schema openapi      # → OpenAPI 3 JSON（等同 GET /openapi.json）
python scripts/deepsonar-api.py schema summary      # → 端点 + scope 摘要
python scripts/deepsonar-api.py schema markdown     # → Markdown 契约（GET /schema.md）

# 或直接 curl
curl -s "$DEEPSONAR_BASE_URL/openapi.json"
curl -s "$DEEPSONAR_BASE_URL/schema?format=summary"
```

## 常用命令

```bash
# 健康与项目
python scripts/deepsonar-api.py health
python scripts/deepsonar-api.py projects list
python scripts/deepsonar-api.py projects create --name my-audit [--description ...] [--plane-project-id <uuid>]
python scripts/deepsonar-api.py projects get <projectId>
python scripts/deepsonar-api.py projects update <projectId> --data '{"description":"..."}'
python scripts/deepsonar-api.py projects archive <projectId>

# 任务（一次任务 = 一个画布；Hub 会自动跟进）
python scripts/deepsonar-api.py tasks create <projectId> --title "审计 auth 模块" --content "目标是 https://github.com/org/repo 的 src/auth，自行决定如何获取材料" --allow-egress true
python scripts/deepsonar-api.py tasks retry <canvasId>

# Job
python scripts/deepsonar-api.py jobs list [--project <projectId>]
python scripts/deepsonar-api.py jobs get <jobId>
python scripts/deepsonar-api.py jobs create --project-id <projectId> --type explore [--title ...] [--payload '{...}']
python scripts/deepsonar-api.py jobs priority <jobId> --priority 10
python scripts/deepsonar-api.py jobs cancel <jobId>
python scripts/deepsonar-api.py jobs resume <jobId>

# Finding / 画布 / 报告
python scripts/deepsonar-api.py findings list [--project <projectId>]
python scripts/deepsonar-api.py canvases list <projectId>
python scripts/deepsonar-api.py canvases get <canvasId>
python scripts/deepsonar-api.py reports get <canvasId>
python scripts/deepsonar-api.py reports markdown <reportId>     # Markdown 原文
python scripts/deepsonar-api.py reports sarif <reportId>        # SARIF 原文
python scripts/deepsonar-api.py reports retry <canvasId>

# Fact 人工验证
python scripts/deepsonar-api.py nodes verify <nodeId> --status verified [--note "..."]

# 事件注入（幂等 source + event_id）
python scripts/deepsonar-api.py events push <projectId> --source ci --event-id build-123 --event-type build_done --content "..."

# 设置
python scripts/deepsonar-api.py settings get
python scripts/deepsonar-api.py settings update --rules '{"maxHubRounds": 8}'
python scripts/deepsonar-api.py project-settings get <projectId>
python scripts/deepsonar-api.py project-settings update <projectId> --rules '{"hubEnabled": true}'
python scripts/deepsonar-api.py project-settings update <projectId> --roles "explore,analyze,review"
python scripts/deepsonar-api.py project-settings update <projectId> --roles null

# 角色 + RoleConfig（含 model / reasoning；需 agents:read|write）
python scripts/deepsonar-api.py roles list
python scripts/deepsonar-api.py roles project <projectId>
python scripts/deepsonar-api.py roles create --name security_review --description "适合处理的任务与能力边界" [--title ...]
python scripts/deepsonar-api.py roles update <roleId> --data '{"description":"..."}'
python scripts/deepsonar-api.py roles delete <roleId>
python scripts/deepsonar-api.py role-configs global
python scripts/deepsonar-api.py role-configs global-put <roleId> --data @role-config.json
python scripts/deepsonar-api.py role-configs list <projectId>
python scripts/deepsonar-api.py role-configs put <projectId> <roleId> --data @role-config.json
python scripts/deepsonar-api.py role-configs delete <projectId> <roleId>

# Skill 模块源
python scripts/deepsonar-api.py skills list
python scripts/deepsonar-api.py skills get <sourceId>
python scripts/deepsonar-api.py skills create --name my-skills --repo-url https://github.com/org/skills [--branch main]
python scripts/deepsonar-api.py skills sync <sourceId>
python scripts/deepsonar-api.py skills trust <sourceId> --status trusted
python scripts/deepsonar-api.py skills delete <sourceId>

# 凭据（明文不可回读；可改 base_url 等 metadata）
python scripts/deepsonar-api.py credentials list
python scripts/deepsonar-api.py credentials create --name kimi --provider kimi --secret '...' [--base-url 'https://...']
python scripts/deepsonar-api.py credentials update <id> --data '{"metadata":{"base_url":"https://ai.example/v1"}}'
python scripts/deepsonar-api.py credentials rotate <id> --secret '...'
python scripts/deepsonar-api.py credentials status <id> --status active|disabled
python scripts/deepsonar-api.py credentials test <id>

# Plane（可选）
python scripts/deepsonar-api.py plane bind <projectId> --project-id <planeProjectUuid>
python scripts/deepsonar-api.py plane unbind <projectId>
python scripts/deepsonar-api.py plane sync <projectId>
python scripts/deepsonar-api.py plane info
```

### RoleConfig 示例（model + 思考强度）

```json
{
  "agent_cli": "claude-code",
  "model": "k3",
  "reasoning": "medium",
  "env_keys": [],
  "env_vars": {},
  "modules": [],
  "skills": [],
  "commands": [],
  "mcps": [],
  "subagents": [],
  "credentials": [{ "credential_id": "<uuid>", "purpose": "llm" }],
  "config_files": []
}
```

## 边界

- 不读取 Credential 明文；
- 不绕过 Scheduler 直改 Job 状态（只用 cancel/resume/priority/retry）；
- 不直接操作 Docker / 数据库；
- 不创建/吊销 API Token、不查审计日志（管理面）；
- RoleConfig 越界配置服务端 400，不要绕过；
- **无 body 的 POST 不要带 `Content-Type: application/json`**（CLI 已处理）。

## 参考

- `references/api.md` — 端点契约（与 `/schema.md` 同步）
- `references/permissions.md` — 最小 scope（**角色/配置用 profiles:\***）
- 运行时权威：`GET /openapi.json`、`GET /schema?format=summary`
