# Plane 连调笔记（2026-07-31 实测）

## 环境

- 形态：**Plane Cloud 免费版**（1–2 人使用足够）
- Base URL：`https://api.plane.so`
- 认证：Header `X-API-Key: plane_api_...`（临时 token，存于 `.env` 的 `PLANE_API_TOKEN`，勿提交）

## 已验证

| 端点 | 结果 |
|------|------|
| `GET /api/v1/users/me/` | ✅ 返回用户（summersec） |
| `GET /api/v1/workspaces/` | ❌ 404（Cloud 公开 API 无此端点，token 是 workspace 级） |
| `GET /api/v1/workspaces/{slug}/projects/` | ✅ 端点存在；slug 错误报 `Workspace not found`，slug 存在但无权限报 `Given API token is not valid` |

## 已确认

- **workspace slug：`sumsec`**（已填入 `.env`）
- 演示项目：`DeepFlowHunter Demo Audit`（identifier `DFH`，id `03846088-8daf-4f87-a1e6-969a37a48baa`）
- 自定义状态：`Ready`（unstarted 组）已建，调度器只领取此状态的 issue
- 演示 issue：`审计 auth 模块（演示）`（描述含 `type=audit_module`、`path=auth/`）

## 真实闭环已验证（2026-07-31）

Ready 领取 → In Progress 回写 + 评论 → 假 agent 审计 → finding → 自动派生验证 → confirmed → Done 回写 + 评论，全链路通过。

## Webhook（官方文档确认的能力）

- 配置位置：workspace **Settings → Webhooks → Add webhook**
- 字段：Payload URL、Secret key（HMAC-SHA256 签名，头部 `X-Plane-Signature` 风格）、事件订阅（Issue / Issue comment / Cycle / Module / Project）
- payload 形态（issue 示例）：`{ event: "issue", action: "created"|"updated"|..., workspace_id, data: { id, name, state, project, ... } }`
- 本地联调：用 ngrok / cloudflared 暴露调度器 `/webhooks/plane` 端点
- **免费版可用**（用户确认）

## 调度器集成约定

- 轮询为主（MVP）：`GET /workspaces/{slug}/projects/{project_id}/issues/?state=Ready` 风格
- Webhook 为辅（Phase 1 末接入）：`issue.updated` → state 变 Ready 时入队，减少空轮询
- 状态回写：`PATCH /workspaces/{slug}/projects/{project_id}/issues/{issue_id}/` 改 state；评论走 issue comments 端点
- 任务参数解析：issue 描述/HTML 里解析 `type=audit_module`、`path=...` 键值对
