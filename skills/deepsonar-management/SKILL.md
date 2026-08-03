---
name: deepsonar-management
description: 通过 DeepSonar API 管理调度平台：先拉 OpenAPI/schema 再操作；项目/任务/Job 生命周期，画布/Finding/报告，RoleConfig（模型 ID/思考强度/运行镜像）、Skill 模块源、凭据、运行时镜像市场、Plane。当需要以程序化方式操作 DeepSonar 时使用。
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

Windows 注意：部分环境下 curl 响应带 UTF-8 BOM，用 Python 解析时 `encoding="utf-8-sig"`；本机常无 `jq`，用 `python -X utf8 -c "import json; ..."`。

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
python scripts/deepsonar-api.py jobs resume <jobId>   # failed/timeout/orphan → pending

# Finding / 画布 / 报告
python scripts/deepsonar-api.py findings list [--project <projectId>] [--canvas <canvasId>]
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
python scripts/deepsonar-api.py project-settings update <projectId> --rules '{"hubEnabled": true, "allowEgress": true}'
python scripts/deepsonar-api.py project-settings update <projectId> --roles "explore,analyze,review"
python scripts/deepsonar-api.py project-settings update <projectId> --roles null

# 角色 + RoleConfig（含 model / reasoning / runtime_image_key；需 agents:read|write）
python scripts/deepsonar-api.py roles list
python scripts/deepsonar-api.py roles project <projectId>
python scripts/deepsonar-api.py roles create --name security_review --description "适合处理的任务与能力边界" [--title ...]
python scripts/deepsonar-api.py roles update <roleId> --data '{"description":"..."}'
python scripts/deepsonar-api.py roles delete <roleId>
python scripts/deepsonar-api.py role-configs global
python scripts/deepsonar-api.py role-configs global-put <roleId> --data @role-config.json
python scripts/deepsonar-api.py role-configs sync-builtin-prompts [--dry-run] [--schema database/schema.sql]
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
python scripts/deepsonar-api.py credentials models <id>   # 实时拉 Provider 模型目录

# 运行时镜像市场（images:*）
python scripts/deepsonar-api.py runtime-images list [--search <kw>] [--project <projectId>]
python scripts/deepsonar-api.py runtime-images get <imageId>
python scripts/deepsonar-api.py runtime-images import --data @import.json   # 202 入队扫描
python scripts/deepsonar-api.py runtime-images rescan <versionId>
python scripts/deepsonar-api.py runtime-images status <versionId> --status trusted [--reason "..."]
python scripts/deepsonar-api.py runtime-images usage <versionId>
python scripts/deepsonar-api.py runtime-images project-enable <projectId> <imageId> --enabled true [--version-id <vid>]
python scripts/deepsonar-api.py runtime-images detect-local <imageId> --image-ref deepsonar-base:local
python scripts/deepsonar-api.py runtime-images adopt-local <imageId> --image-ref deepsonar-base:local --expected-image-id sha256:<64hex>

# Plane（可选）
python scripts/deepsonar-api.py plane bind <projectId> --project-id <planeProjectUuid>
python scripts/deepsonar-api.py plane unbind <projectId>
python scripts/deepsonar-api.py plane sync <projectId>
python scripts/deepsonar-api.py plane info
```

### RoleConfig 示例（model + 思考强度 + 镜像 + 凭据）

```json
{
  "agent_cli": "claude-code",
  "model": "k3",
  "reasoning": "high",
  "env_keys": [],
  "env_vars": {},
  "modules": [],
  "skills": [],
  "commands": [],
  "mcps": [],
  "subagents": [],
  "runtime_image_key": "deepsonar-base",
  "credentials": [{ "credential_id": "<uuid>", "purpose": "llm" }],
  "config_files": []
}
```

**审计角色**常用 `runtime_image_key: "deepsonar-audit"`；Hub / explore / analyze / code 用 `deepsonar-base`。  
`purpose` 必须是 **`llm`**（调度器只认这个 purpose 注入模型通道）。

## 推荐工作流：清库 → 配多模型 → 下发全量审计

```bash
# 1) 健康 + 契约
python scripts/deepsonar-api.py health
python scripts/deepsonar-api.py schema summary

# 2) 确认凭据与可用模型（按凭据分流，不要所有角色绑同一 model）
python scripts/deepsonar-api.py credentials list
python scripts/deepsonar-api.py credentials models <kimiCredId>
python scripts/deepsonar-api.py credentials models <otherCredId>

# 3) 确认镜像市场已有 trusted 版本（real 模式硬门槛）
python scripts/deepsonar-api.py runtime-images list
# 若 latest_version / digest 为空：先在 .env 配官方不可变 digest 并重启调度器：
#   DEEPSONAR_OFFICIAL_BASE_IMAGE=repo/image@sha256:...
#   DEEPSONAR_OFFICIAL_AUDIT_IMAGE=repo/image@sha256:...
# 本地镜像采用是两步操作：先 detect-local，再由管理员核对 image_id 后 adopt-local（images:approve）。
# adopt-local 只接受服务端检测得到的 adoptable 候选；不会因为输入 mutable tag 就自动信任。

# 4) 拉全局 RoleConfig，按角色 PUT 不同 model/credential/reasoning
python scripts/deepsonar-api.py role-configs global
# hub_reason → 用户指定模型 + high 思考；audit/verify 可同系；explore/analyze/review 用另一凭据

# 5) 建项目 + 打开 hub/出网 + 下发单任务
python scripts/deepsonar-api.py projects create --name "java-sec-code 全量审计" \
  --description "https://github.com/SummerSec/java-sec-code"
python scripts/deepsonar-api.py project-settings update <projectId> \
  --rules '{"hubEnabled":true,"allowEgress":true}'
python scripts/deepsonar-api.py tasks create <projectId> \
  --title "全量审计" \
  --content "目标仓库：https://github.com/SummerSec/java-sec-code 。全量安全审计……" \
  --allow-egress true

# 6) 盯 Job：pending → claimed → provisioning → running；orphan 用 resume
python scripts/deepsonar-api.py jobs list --project <projectId>
python scripts/deepsonar-api.py jobs get <jobId>
python scripts/deepsonar-api.py jobs resume <jobId>
```

## Real 模式前置清单（缺一 job 会 pending/failed/orphan）

| 项 | 说明 |
| --- | --- |
| `AGENT_MODE=real` | `.env`；fake 只跑状态机 |
| 主密钥 | `DEEPSONAR_MASTER_KEY_FILE` / `DEEPSONAR_MASTER_KEY`（32 字节） |
| 活跃 Credential | 绑定到 RoleConfig，`purpose=llm` |
| 可信镜像版本 | `runtime_image_versions.trust_status=trusted` 且 `image_ref` 含 `@sha256:` |
| 官方 digest 引导 | `DEEPSONAR_OFFICIAL_BASE_IMAGE` / `DEEPSONAR_OFFICIAL_AUDIT_IMAGE`（tag 不会被静默信任） |
| 本地镜像存在 | Docker 已有对应 digest（可 `docker tag` 别名） |
| schema 版本 | `schema_meta.version` 必须等于 `apps/scheduler/src/db.ts` 的 `SCHEMA_VERSION`；**无增量迁移**，不符则重建库 |
| 鉴权 | `DEEPSONAR_AUTH_REQUIRED=true` 时需 Bearer；应急用 `DEEPSONAR_ADMIN_TOKEN`（不落库） |
| 证据目录 | `BLOB_DIR`（默认 `./data/blobs`）可写；改 `apps/scheduler/src` 会触发 tsx watch 重载 |

## 运维踩坑（本 skill 经验沉淀）

1. **清业务数据不要 `TRUNCATE projects CASCADE`**：会连带清空 `credentials` / `role_configs`（FK）。应显式列出业务表，**保留** `credentials`、`agent_roles`、`role_configs`、`skill_sources`、`runtime_images*`、`users`、`schema_meta`、`global_settings`。平台导出包（`.deepsonarpack`）**不含凭据明文**，清掉后只能从 `.env`/密钥管理重新 `credentials create`。
2. **git pull 后 schema  bump**：调度器启动若报「当前数据库不是 schema vN」，只能 `DROP SCHEMA public CASCADE` + 重启让空库套 `database/schema.sql`，再恢复凭据与 RoleConfig。
3. **RoleConfig PUT 400 `runtime_image_key 没有可信版本`**：市场 catalog 有 key 不等于有 trusted version。先 bootstrap 官方 digest 或 import+approve。
4. **多模型分配**：`credentials models` 看各 Provider 真实目录；hub 与 worker 可不同凭证。Job 快照在创建时冻结，改 RoleConfig **不影响**已创建 job。
5. **tsx watch 改 src 会重载**：running job → `orphan`（「调度器重启」）；`jobs resume` 回 pending。排障时先确认无 running job 再改代码，或接受重跑。
6. **`jobs resume` 后若轮询关闭**：依赖 `pg_notify`；schema 触发器须覆盖 pending 恢复路径（基线已含）。
7. **dispatcher `FOR UPDATE` + `LEFT JOIN credentials`**：必须 `FOR UPDATE OF j`，否则 Postgres `0A000` 导致领取失败。
8. **证据 stream 写盘**：`stream.ndjson` 在 `attempts/<sandboxId>/` 下，mkdir 必须建 attempt 目录，否则 unhandledRejection ENOENT。
9. **无 body 的 POST**（sync / test / cancel / resume / models）**不要**带 `Content-Type: application/json`（CLI 已处理）。
10. **端口**：`SCHEDULER_PORT`（默认 3100），不是 `PORT`；EADDRINUSE = 已有实例，先按 PID 清干净再起唯一实例。
11. **Windows 启动 pnpm**：`Start-Process` 用 `pnpm.cmd` 全路径，不要直接 `pnpm`（.ps1 不是 Win32 应用）。

## 边界

- 不读取 Credential 明文；
- 不绕过 Scheduler 直改 Job 状态（只用 cancel/resume/priority/retry）；
- 不直接操作 Docker / 数据库（除非用户明确要求清库/重建，且须保留凭据策略）；
- 不创建/吊销 API Token、不查审计日志（管理面，除非用户给了 admin token 且明确要求）；
- RoleConfig 越界配置服务端 400，不要绕过；
- 不把任意镜像 ref 塞进任务 content / Hub prompt——镜像只能来自市场 + RoleConfig `runtime_image_key`。

## 参考

- `references/api.md` — 端点契约（与 `/schema.md` 同步）
- `references/permissions.md` — 最小 scope（角色/凭据用 `agents:*`；镜像用 `images:*`）
- 运行时权威：`GET /openapi.json`、`GET /schema?format=summary`
