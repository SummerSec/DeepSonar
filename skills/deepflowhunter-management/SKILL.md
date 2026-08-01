---
name: deepflowhunter-management
description: 通过 DeepFlowHunter API 管理调度平台：项目/任务/Job 生命周期，查看画布、Finding 与任务报告（Markdown/SARIF），人工验证 Fact，管理角色与 RoleConfig、Skill 模块源、规则设置，绑定 Plane。当需要以程序化方式操作 DeepFlowHunter 调度平台时使用。
---

# DeepFlowHunter Management

让外部 Agent（Codex / Claude Code / CI）通过最小权限 API Token 管理 DeepFlowHunter，
不依赖浏览器手工操作。除报告下载外所有动作输出结构化 JSON（stdout），便于下游 Agent 继续处理。

## 使用方式

```bash
export DFH_BASE_URL=http://localhost:3100
export DFH_API_TOKEN=dfh_dev_xxxxxxxx_xxxxxxxx   # 项目级最小 scope Token（见 references/permissions.md）

python scripts/dfh-api.py <command> [args...] [--flag value...]
```

复杂 JSON 参数（`--data` / `--rules` / `--payload`）可内联传 JSON，也可用 `@path/to/file.json` 从文件读取。

常用命令：

```bash
# 健康与项目
python scripts/dfh-api.py health
python scripts/dfh-api.py projects list
python scripts/dfh-api.py projects create --name my-audit [--description ...] [--plane-project-id <uuid>]
python scripts/dfh-api.py projects get <projectId>
python scripts/dfh-api.py projects update <projectId> --data '{"description":"..."}'
python scripts/dfh-api.py projects archive <projectId>

# 任务（一次任务 = 一个画布；Hub 编排会自动跟进 verify/followup）
python scripts/dfh-api.py tasks create <projectId> --title "审计 auth 模块" --module-path src/auth
python scripts/dfh-api.py tasks create <projectId> --title "审计仓库" --repo-url https://github.com/org/repo [--ref main]
python scripts/dfh-api.py tasks retry <canvasId>

# Job 操作
python scripts/dfh-api.py jobs list [--project <projectId>]
python scripts/dfh-api.py jobs get <jobId>
python scripts/dfh-api.py jobs create --project-id <projectId> --type explore [--title ...] [--payload '{...}']
python scripts/dfh-api.py jobs priority <jobId> --priority 10
python scripts/dfh-api.py jobs cancel <jobId>
python scripts/dfh-api.py jobs resume <jobId>

# 结果：Finding / 画布 / 报告
python scripts/dfh-api.py findings list [--project <projectId>]
python scripts/dfh-api.py canvases list <projectId>
python scripts/dfh-api.py canvases get <canvasId>
python scripts/dfh-api.py reports get <canvasId>          # 报告状态 + uri
python scripts/dfh-api.py reports markdown <reportId>     # 输出 Markdown 原文（非 JSON）
python scripts/dfh-api.py reports sarif <reportId>        # 输出 SARIF 原文（非 JSON）
python scripts/dfh-api.py reports retry <canvasId>        # 仅 failed 可重试

# Fact 人工验证（needs_human 的确认/排除；处理后可能推进报告生成）
python scripts/dfh-api.py nodes verify <nodeId> --status verified [--note "..."]

# 事件注入（幂等：source + event_id）
python scripts/dfh-api.py events push <projectId> --source ci --event-id build-123 --event-type build_done --content "新构建完成"

# 设置（全局规则默认值 / 项目覆盖 / 角色启停）
python scripts/dfh-api.py settings get
python scripts/dfh-api.py settings update --rules '{"maxHubRounds": 8}'
python scripts/dfh-api.py project-settings get <projectId>
python scripts/dfh-api.py project-settings update <projectId> --rules '{"hubEnabled": true}'
python scripts/dfh-api.py project-settings update <projectId> --roles "explore,analyze,review"   # 启用清单
python scripts/dfh-api.py project-settings update <projectId> --roles null                       # 恢复默认

# 角色注册表与 RoleConfig（角色 → agent 配置；全局缺省 + 项目级覆盖）
python scripts/dfh-api.py roles list
python scripts/dfh-api.py roles project <projectId>
python scripts/dfh-api.py roles create --name security_review --prompt-template "..." [--title ...]
python scripts/dfh-api.py roles update <roleId> --data '{"description":"..."}'
python scripts/dfh-api.py roles delete <roleId>
python scripts/dfh-api.py role-configs global
python scripts/dfh-api.py role-configs global-put <roleId> --data @role-config.json
python scripts/dfh-api.py role-configs list <projectId>
python scripts/dfh-api.py role-configs put <projectId> <roleId> --data @role-config.json
python scripts/dfh-api.py role-configs delete <projectId> <roleId>

# Skill 模块源（Git 托管；新源默认 quarantined，trust 后才下发）
python scripts/dfh-api.py skills list
python scripts/dfh-api.py skills get <sourceId>
python scripts/dfh-api.py skills create --name my-skills --repo-url https://github.com/org/skills [--branch main]
python scripts/dfh-api.py skills sync <sourceId>
python scripts/dfh-api.py skills trust <sourceId> --status trusted
python scripts/dfh-api.py skills delete <sourceId>

# Plane 集成（可选）
python scripts/dfh-api.py plane bind <projectId> --project-id <planeProjectUuid>
python scripts/dfh-api.py plane unbind <projectId>
python scripts/dfh-api.py plane sync <projectId>
python scripts/dfh-api.py plane info
```

## 边界（本 Skill 不做的事）

- 不读取 Credential 明文（API 本身也不返回）；
- 不绕过 Scheduler 直接改任意 Job 状态（只走 cancel/resume/priority/retry 端点）；
- 不直接操作 Docker / 数据库；
- 不创建/吊销 API Token、不查审计日志（tokens:manage / admin 属管理面操作，见 references/permissions.md）；
- RoleConfig 越界配置（白名单外 env、不可信镜像、跨项目 Credential、含密钥特征的配置文件）服务端会 400 拒绝，不要尝试绕过。

## 参考

- `references/api.md` — 端点契约、scope 对照与错误格式
- `references/permissions.md` — 推荐的最小 scope 集合
