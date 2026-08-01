---
name: deepflowhunter-management
description: 通过 DeepFlowHunter API 管理项目与任务：列出/创建/归档项目，创建任务、调整优先级、取消/恢复 Job，查看画布与 Finding，绑定 Plane，查询健康状态。当需要以程序化方式操作 DeepFlowHunter 调度平台时使用。
---

# DeepFlowHunter Management

让外部 Agent（Codex / Claude Code / CI）通过最小权限 API Token 管理 DeepFlowHunter，
不依赖浏览器手工操作。所有动作输出结构化 JSON（stdout），便于下游 Agent 继续处理。

## 使用方式

```bash
export DFH_BASE_URL=http://localhost:3100
export DFH_API_TOKEN=dfh_dev_xxxxxxxx_xxxxxxxx   # 项目级最小 scope Token（见 references/permissions.md）

node scripts/dfh-api.mjs <command> [args...] [--flag value...]
```

常用命令：

```bash
# 健康与项目
node scripts/dfh-api.mjs health
node scripts/dfh-api.mjs projects list
node scripts/dfh-api.mjs projects create --name my-audit
node scripts/dfh-api.mjs projects get <projectId>
node scripts/dfh-api.mjs projects archive <projectId>

# 任务（一次任务 = 一个画布；Hub 编排会自动跟进 verify/followup）
node scripts/dfh-api.mjs tasks create <projectId> --title "审计 auth 模块" --module-path src/auth
node scripts/dfh-api.mjs tasks create <projectId> --title "审计仓库" --repo-url https://github.com/org/repo

# Job 操作
node scripts/dfh-api.mjs jobs list [--project <projectId>]
node scripts/dfh-api.mjs jobs get <jobId>
node scripts/dfh-api.mjs jobs priority <jobId> --priority 10
node scripts/dfh-api.mjs jobs cancel <jobId>
node scripts/dfh-api.mjs jobs resume <jobId>

# 结果查看
node scripts/dfh-api.mjs findings list [--project <projectId>]
node scripts/dfh-api.mjs canvases list <projectId>
node scripts/dfh-api.mjs canvases get <canvasId>

# 事件注入（幂等：source + event_id）
node scripts/dfh-api.mjs events push <projectId> --source ci --event-id build-123 --event-type build_done --content "新构建完成"

# Plane 集成
node scripts/dfh-api.mjs plane bind <projectId> --project-id <planeProjectUuid>
node scripts/dfh-api.mjs plane unbind <projectId>
```

## 边界（本 Skill 不做的事）

- 不读取 Provider Credential 明文（API 本身也不返回）；
- 不绕过 Scheduler 直接改任意 Job 状态（只走 cancel/resume/priority 端点）；
- 不直接操作 Docker / 数据库；
- 不创建/吊销 API Token（tokens:manage 属管理面操作，见 references/permissions.md）。

## 参考

- `references/api.md` — 端点契约与错误格式
- `references/permissions.md` — 推荐的最小 scope 集合
