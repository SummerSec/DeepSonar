---
name: deepsonar-management
description: 通过 DeepSonar API 管理调度平台：先拉 OpenAPI/schema 再操作；项目、standard/compose/定时任务、Job 生命周期，画布 Fact/广播/人工消息、Finding/报告，RoleConfig、Provider、Skill 模块源、凭据、运行时镜像市场、平台导入导出与 Plane。当需要以程序化方式操作 DeepSonar 时使用。
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
python scripts/deepsonar-api.py tasks create <projectId> --title "审计 auth 模块" --content "目标是 https://github.com/org/repo 的 src/auth，自行决定如何获取材料" --kind standard --allow-egress true
python scripts/deepsonar-api.py tasks create <projectId> --title "组合验证" --kind compose --seed-finding-ids '<findingId1>,<findingId2>'
python scripts/deepsonar-api.py tasks create <projectId> --title "明早执行" --kind standard --schedule-beijing-8am true
python scripts/deepsonar-api.py tasks create <projectId> --title "定时执行" --kind standard --scheduled-start-at 2026-08-20T01:00:00.000Z
python scripts/deepsonar-api.py tasks retry <canvasId>

# Job
python scripts/deepsonar-api.py jobs list [--project <projectId>]
python scripts/deepsonar-api.py jobs get <jobId>
python scripts/deepsonar-api.py jobs events <jobId> [--cursor ...] [--limit 100]
python scripts/deepsonar-api.py jobs evidence <jobId>   # evidence manifest
python scripts/deepsonar-api.py jobs evidence-session <jobId>
python scripts/deepsonar-api.py jobs evidence-session-download <jobId> --out session.ndjson
python scripts/deepsonar-api.py jobs evidence-stream <jobId> [--cursor ...] [--limit 100] [--tail true]
python scripts/deepsonar-api.py jobs create --project-id <projectId> --type explore [--title ...] [--payload '{...}']
python scripts/deepsonar-api.py jobs priority <jobId> --priority 10
python scripts/deepsonar-api.py jobs cancel <jobId>
python scripts/deepsonar-api.py jobs resume <jobId>   # failed/timeout/orphan/waiting_human → pending；按 type/purpose 重新归一化固定 priority class

# Finding / 画布 / 报告
python scripts/deepsonar-api.py findings list [--project <projectId>] [--canvas <canvasId>]
python scripts/deepsonar-api.py findings get <findingId>
python scripts/deepsonar-api.py findings disposition <findingId> --disposition confirmed_vuln [--note ...]
python scripts/deepsonar-api.py findings comment <findingId> --body "..." [--request-hub false]
python scripts/deepsonar-api.py findings link <findingId> --url https://tracker/item [--link-type ticket]
python scripts/deepsonar-api.py canvases list <projectId>
python scripts/deepsonar-api.py canvases get <canvasId>
python scripts/deepsonar-api.py canvases broadcasts <canvasId> [--limit 100]
python scripts/deepsonar-api.py facts list <canvasId> [--verification-status needs_human] [--evidence-kind review,test]
python scripts/deepsonar-api.py facts get <canvasId> <nodeId>
python scripts/deepsonar-api.py facts verify <canvasId> <nodeId> --status verified [--note "..."]
python scripts/deepsonar-api.py messages list <canvasId> [--limit 100]
python scripts/deepsonar-api.py messages send <canvasId> --message-id <uuid> --target-kind hub --body "请继续核查"
python scripts/deepsonar-api.py messages send <canvasId> --message-id <uuid> --target-kind job --target-node-id <nodeId> --body "请验证此路径" [--attachment-version-ids '<versionId1>,<versionId2>']
python scripts/deepsonar-api.py reports get <canvasId>
python scripts/deepsonar-api.py reports finding <findingId>
python scripts/deepsonar-api.py reports finding-create <findingId>
python scripts/deepsonar-api.py reports markdown <reportId>     # Markdown 原文
python scripts/deepsonar-api.py reports sarif <reportId>        # SARIF 原文
python scripts/deepsonar-api.py reports retry <canvasId>

# 事件注入（幂等 source + event_id）
python scripts/deepsonar-api.py events push <projectId> --source ci --event-id build-123 --event-type build_done --content "..."

# 设置
python scripts/deepsonar-api.py settings get
python scripts/deepsonar-api.py settings update --rules '{"maxHubRounds": 8}'
# 调度并发：库内 global_settings.rules_json 优先；.env 仅在库未配置时提供启动默认
# 代码/env 默认 maxGlobalJobs=20、maxJobsPerProject=5（0 仅暂停对应 CLI）
python scripts/deepsonar-api.py settings update --rules '{"maxGlobalJobs": 20, "maxJobsPerProject": 5, "maxConcurrentProvisioning": 2, "maxConcurrentByAgentCli": {"claude-code": 4}}'
python scripts/deepsonar-api.py settings update --max-global-jobs 20 --max-jobs-per-project 5 --max-concurrent-provisioning 2 --cli-limits '{"claude-code": 4}'
# rootless Docker + vfs 主机建议把持久化值设为 1
python scripts/deepsonar-api.py settings update --max-concurrent-provisioning 1
python scripts/deepsonar-api.py project-settings get <projectId>
python scripts/deepsonar-api.py project-settings update <projectId> --rules '{"hubEnabled": true, "allowEgress": true}'
python scripts/deepsonar-api.py project-settings update <projectId> --roles "explore,analyze,review"
python scripts/deepsonar-api.py project-settings update <projectId> --roles null
python scripts/deepsonar-api.py readiness
python scripts/deepsonar-api.py readiness project <projectId> [--allow-egress true] [--material-source declared]

# 共享资产（上传用原始字节；--file 不会把内容打印到 stdout）
python scripts/deepsonar-api.py assets project-list <projectId>
python scripts/deepsonar-api.py assets project-upload <projectId> --asset-key report.json --file report.json --content-type application/json
python scripts/deepsonar-api.py assets finding-list <findingId>
python scripts/deepsonar-api.py assets platform-list
python scripts/deepsonar-api.py assets download <assetId> --out evidence.bin
python scripts/deepsonar-api.py assets archive <assetId>

# 角色 + RoleConfig（agents:read|write）
# Web：CLI / 凭据 / 模型 / 镜像在「凭据 · Provider 绑定」；指令 / 平台工具 / 模块在「Agent 角色」
python scripts/deepsonar-api.py roles list
python scripts/deepsonar-api.py roles project <projectId>
python scripts/deepsonar-api.py roles create --name security_review --description "适合处理的任务与能力边界" [--title ...]
python scripts/deepsonar-api.py roles update <roleId> --data '{"description":"..."}'
python scripts/deepsonar-api.py roles delete <roleId>
python scripts/deepsonar-api.py role-configs global
python scripts/deepsonar-api.py role-configs global-put <roleId> --data @role-config.json
python scripts/deepsonar-api.py role-configs bindable
# Provider 绑定列表等价轻量 PATCH（不改写凭据/config_files）
python scripts/deepsonar-api.py role-configs agent-cli <roleConfigId> --agent-cli claude-code
python scripts/deepsonar-api.py role-configs runtime-image <roleConfigId> --image-key deepsonar-audit
python scripts/deepsonar-api.py role-configs runtime-image <roleConfigId> --image-key null   # 系统底座
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

# 凭据（LLM provider 是协议 ID，不是厂商品牌；明文不可回读）
python scripts/deepsonar-api.py credentials list
python scripts/deepsonar-api.py credentials providers
python scripts/deepsonar-api.py credentials get <id>
python scripts/deepsonar-api.py credentials impact <id>
python scripts/deepsonar-api.py credentials create --name claude-proxy --provider anthropic --agent-cli claude-code --secret '...' --settings-config @claude-settings.json [--base-url 'https://...']
python scripts/deepsonar-api.py credentials create --name codex-proxy --provider openai --agent-cli codex --secret '...' --settings-config @codex-settings.json [--base-url 'https://...']
python scripts/deepsonar-api.py credentials models-preview --provider anthropic --agent-cli claude-code --secret '...' --base-url 'https://...' --settings-config @claude-settings.json
python scripts/deepsonar-api.py credentials update <id> --data '{"metadata":{"base_url":"https://ai.example/v1"}}'
python scripts/deepsonar-api.py credentials rotate <id> --secret '...'
python scripts/deepsonar-api.py credentials status <id> --status active|disabled
python scripts/deepsonar-api.py credentials test <id>
python scripts/deepsonar-api.py credentials models <id>   # 已缓存模型目录
python scripts/deepsonar-api.py credentials models-refresh <id>   # 连接 Provider 刷新目录
python scripts/deepsonar-api.py credentials compatibility <id> [--agent-cli claude-code] [--model ...]
python scripts/deepsonar-api.py credentials batch-bind --credential-id <id> --role-config-ids '["<id>"]' --idempotency-key change-20260809

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
python scripts/deepsonar-api.py runtime-images registry
python scripts/deepsonar-api.py runtime-images registry-channel --channel github
python scripts/deepsonar-api.py runtime-images registry-sync
python scripts/deepsonar-api.py runtime-images registry-apply --data @runtime-image-registry.json   # 当前为 admin-only
python scripts/deepsonar-api.py runtime-images registry-pull
python scripts/deepsonar-api.py runtime-images registry-pull-status
python scripts/deepsonar-api.py runtime-images official-digest <imageId> --image-ref repo/image@sha256:... [--version 1.0.0]
python scripts/deepsonar-api.py runtime-images manual-digest --image-key custom --name "Custom" --publisher team --image-ref repo/image@sha256:...

# 项目/平台 transfer（.deepsonarpack；--file 上传、--out 下载）
python scripts/deepsonar-api.py exports create --project-id <projectId> --preset project_full --include-blobs true
python scripts/deepsonar-api.py exports create --preset platform_full
python scripts/deepsonar-api.py exports list [--project-id <projectId>]
python scripts/deepsonar-api.py exports get <exportId>
python scripts/deepsonar-api.py exports download <exportId> --out project.deepsonarpack
python scripts/deepsonar-api.py exports cancel <exportId>
python scripts/deepsonar-api.py imports upload --file project.deepsonarpack
python scripts/deepsonar-api.py imports get <importId>
python scripts/deepsonar-api.py imports preview <importId>
python scripts/deepsonar-api.py imports apply <importId> --mode create_new [--project-name restored]
python scripts/deepsonar-api.py imports cancel <importId>

# Plane（可选）
python scripts/deepsonar-api.py plane bind <projectId> --project-id <planeProjectUuid>
python scripts/deepsonar-api.py plane unbind <projectId>
python scripts/deepsonar-api.py plane sync <projectId>
python scripts/deepsonar-api.py plane info
```

### RoleConfig 示例（Credential 绑定 + 可选 model 覆盖 + 镜像）

```json
{
  "agent_cli": "claude-code",
  "model": null,
  "env_keys": [],
  "env_vars": {},
  "modules": [],
  "skills": [],
  "commands": [],
  "mcps": [],
  "subagents": [],
  "platform_tools": {},
  "instructions_markdown": null,
  "runtime_image_key": null,
  "sandbox_limits": null,
  "credentials": [{ "credential_id": "<uuid>", "purpose": "llm" }],
  "config_files": []
}
```

- `runtime_image_key: null` = **系统底座**（调度默认 deepsonar-base，不必写 key）。
- 官方专项：`deepsonar-audit`、`deepsonar-kali-minimal`、Chrome 系列（`deepsonar-chrome-audit`、`deepsonar-chrome-test`、`deepsonar-chrome-fuzz`）及 OpenHarmony 系列（`deepsonar-openharmony-*`，`project_opt_in`）。
- `sandbox_limits` 仅是项目 RoleConfig 的覆盖（读取项目投影时为 `sandbox_limits_json`，CPU/内存/PIDs 等）；仍受服务端硬上限约束，Job 创建时冻结。
- **OpenHarmony 等 opt-in 专项**：RoleConfig 可先 pin；**真正跑 Job** 仍要求项目在镜像市场启用。
- `platform_tools`：每个 Agent **全量可选**；未声明 = 全开；仅 **`mark_job_done` 不可关**。
- `purpose` 必须是 **`llm`**（调度器只认这个 purpose 注入模型通道）。
- `model: null` 表示使用 Credential 的 CLI 配置文件；仅高级场景才在 RoleConfig 填覆盖模型。
- Finding 协议默认 **CVSS 3.1**（接受 3.1/4.0）；UI 只暴露模式 hybrid/fixed/agent_choice。

## 推荐工作流：清库 → 配多模型 → 下发全量审计

```bash
# 1) 健康 + 契约
python scripts/deepsonar-api.py health
python scripts/deepsonar-api.py schema summary

# 2) 确认凭据配置文件与可用模型目录
python scripts/deepsonar-api.py credentials list
python scripts/deepsonar-api.py credentials models <anthropicCredentialId>
python scripts/deepsonar-api.py credentials models <openaiCredentialId>

# 3) 确认镜像市场已有 trusted 版本（real 模式硬门槛）
python scripts/deepsonar-api.py runtime-images list
# 若 latest_version / digest 为空：先在 .env 配官方不可变 digest 并重启调度器：
#   DEEPSONAR_OFFICIAL_BASE_IMAGE=repo/image@sha256:...
#   DEEPSONAR_OFFICIAL_AUDIT_IMAGE=repo/image@sha256:...
# 本地镜像采用是两步操作：先 detect-local，再由管理员核对 image_id 后 adopt-local（images:approve）。
# adopt-local 只接受服务端检测得到的 adoptable 候选；不会因为输入 mutable tag 就自动信任。

# 4) 拉全局 RoleConfig，按角色绑定不同 Credential 配置文件；model 默认 null
python scripts/deepsonar-api.py role-configs global
# hub_reason → Credential 配置文件 + high 思考；需要时才用 RoleConfig.model 覆盖

# 5) 建项目 + 打开 hub/出网 + 下发单任务
python scripts/deepsonar-api.py projects create --name "java-sec-code 全量审计" \
  --description "https://github.com/SummerSec/java-sec-code"
python scripts/deepsonar-api.py project-settings update <projectId> \
  --rules '{"hubEnabled":true,"allowEgress":true}'
python scripts/deepsonar-api.py tasks create <projectId> \
  --title "全量审计" \
  --content "目标仓库：https://github.com/SummerSec/java-sec-code 。全量安全审计……" \
  --allow-egress true

# 6) 盯 Job：pending → claimed → provisioning → running/waiting_human；终态或 waiting_human 用 resume（会重算固定 priority class）
python scripts/deepsonar-api.py jobs list --project <projectId>
python scripts/deepsonar-api.py jobs get <jobId>
python scripts/deepsonar-api.py jobs resume <jobId>
```

## Real 模式前置清单（缺一 job 会 pending/failed/orphan）

| 项 | 说明 |
| --- | --- |
| `AGENT_MODE=real` | `.env`；fake 只跑状态机 |
| 主密钥 | `DEEPSONAR_MASTER_KEY_FILE` / `DEEPSONAR_MASTER_KEY`（32 字节） |
| 活跃 Credential | 绑定到 RoleConfig，`purpose=llm`；Provider 绑定流可批量绑定 |
| 可信镜像版本 | `runtime_image_versions.trust_status=trusted` 且 `image_ref` 含 `@sha256:` |
| 官方 digest 引导 | `DEEPSONAR_OFFICIAL_BASE_IMAGE` / `DEEPSONAR_OFFICIAL_AUDIT_IMAGE`（tag 不会被静默信任） |
| 本地镜像存在 | Docker 已有对应 digest（可 `docker tag` 别名） |
| 并发默认 | `MAX_GLOBAL_JOBS=20`、`MAX_JOBS_PER_PROJECT=5`（库 `rules_json` 优先） |
| schema 版本 | 以运行中 `/schema` 为准；远端 `origin/main` 最新基线为 v24，当前未同步工作树仍可能是 v23。空库套对应 checkout 的 `database/schema.sql`，非空只校验版本与结构；不符 fail closed（无增量 migration，需重建） |
| 鉴权 | `DEEPSONAR_AUTH_REQUIRED=true` 时需 Bearer；应急用 `DEEPSONAR_ADMIN_TOKEN`（不落库） |
| 证据目录 | `BLOB_DIR`（默认 `./data/blobs`）可写；共享资产 CAS 见 `BLOB_STORE=fs` 或 `s3`（`docs/SHARED_ASSET_BLOB_STORE.md`）；改 `apps/scheduler/src` 会触发 tsx watch 重载 |

## 运维踩坑（本 skill 经验沉淀）

1. **清业务数据不要 `TRUNCATE projects CASCADE`**：会连带清空 `credentials` / `role_configs`（FK）。应显式列出业务表，**保留** `credentials`、`agent_roles`、`role_configs`、`skill_sources`、`runtime_images*`、`users`、`schema_meta`、`global_settings`。平台导出包（`.deepsonarpack`）**不含凭据明文**，清掉后只能从 `.env`/密钥管理重新 `credentials create`。平台导出模块可自由勾选（`POST /platform/exports`：`preset=custom` + `modules[]`）。
2. **git pull 后 schema bump**：先 `pg_dump -Fc`；版本不符时 Scheduler 会 fail closed。无自动升级——备份业务数据后对空库套 `database/schema.sql`（或让 Scheduler 对空库引导），再按需导入 `.deepsonarpack`。
3. **RoleConfig 镜像**：`runtime_image_key 没有可信版本` = catalog 有 key 但无 trusted version。官方 digest 引导或 import+approve。`PATCH .../runtime-image` 返回 **404** = 调度器未加载新路由，重启后再试。OpenHarmony 等 `project_opt_in` 可 pin 到 RoleConfig，Job 解析仍要求项目启用。
4. **多模型分配**：`credentials models` 看各 Provider 真实目录；hub 与 worker 可不同凭证。Job 快照在创建时冻结，改 RoleConfig **不影响**已创建 job。CLI/镜像轻量 PATCH 与 Provider 绑定 UI 等价。
5. **tsx watch 改 src 会重载**：running job → `orphan`（「调度器重启」）；`jobs resume`（也支持 waiting_human）回 pending 并重算固定 priority class。排障时先确认无 running job 再改代码，或接受重跑。
6. **`jobs resume` 后若轮询关闭**：依赖 `pg_notify`；schema 触发器须覆盖 pending 恢复路径（基线已含）。
7. **dispatcher `FOR UPDATE` + `LEFT JOIN credentials`**：必须 `FOR UPDATE OF j`，否则 Postgres `0A000` 导致领取失败。
8. **证据 stream 写盘**：`stream.ndjson` 在 `attempts/<sandboxId>/` 下，mkdir 必须建 attempt 目录，否则 unhandledRejection ENOENT。
9. **无 body 的 POST**（sync / test / resume / model refresh）**不要**带 `Content-Type: application/json`（CLI 已处理）；cancel 仅在传 `--force/--reason` 时带 JSON body。
10. **端口**：`SCHEDULER_PORT`（默认 3100），不是 `PORT`；EADDRINUSE = 已有实例，先按 PID 清干净再起唯一实例。
11. **Windows 启动 pnpm**：`Start-Process` 用 `pnpm.cmd` 全路径，不要直接 `pnpm`（.ps1 不是 Win32 应用）。
12. **并发显示 6/2 而非 20/5**：库 `global_settings.rules_json` 已写死旧值；改 `.env` 不够，需 PATCH rules 或更新库内字段。

## 边界

- 不读取 Credential 明文；
- 不绕过 Scheduler 直改 Job 状态（只用 cancel/resume/priority/retry）；
- 不直接操作 Docker / 数据库（除非用户明确要求清库/重建，且须保留凭据策略）；
- 不创建/吊销 API Token、不查审计日志（管理面，除非用户给了 admin token 且明确要求）；
- `tasks delete`、`exports delete`、`imports delete` 会删除持久化对象或制品，只在用户明确指定目标并确认删除意图时使用；
- Agent Marketplace 的 AgentPack（`deepsonar.agentpack/v1`）目前由 Web 本地导入/安装（通常创建 Agent Role + RoleConfig），没有服务端 `/agent-packs` 管理端点；不要把它写成 API 能力。
- RoleConfig 越界配置服务端 400，不要绕过；
- 不把任意镜像 ref 塞进任务 content / Hub prompt——镜像只能来自市场 + RoleConfig `runtime_image_key`。

## 参考

- `references/api.md` — 端点契约（与 `/schema.md` 同步）
- `references/permissions.md` — 最小 scope（角色/凭据用 `agents:*`；镜像用 `images:*`）
- 运行时权威：`GET /openapi.json`、`GET /schema?format=summary`
