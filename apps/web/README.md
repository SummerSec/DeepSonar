# @dfh/web — DeepFlowHunter 控制台

技术选型：React + React Router + React Flow（@xyflow/react）+ Tailwind

## 信息架构

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 总览 | 跨项目活跃 Job、最近发现、项目卡片 |
| `/projects` | 项目列表 | Plane 绑定项目 |
| `/projects/:id/tasks` | 任务表 | 一任务一画布，可按活跃/有发现筛选 |
| `/projects/:id/tasks/:canvasId` | 过程画布 | 只读 React Flow + 节点详情侧栏 |
| `/projects/:id/findings` | 项目发现 | severity / 验证状态筛选 |
| `/projects/:id/settings` | 项目设置 | Agent profile / 规则 / 模块源 |
| `/jobs` | 调度队列 | 全局 Job，支持取消 / 恢复 |
| `/findings` | 全局发现 | 跨项目 finding 清单 |

## 数据源

- `GET /projects`、`/projects/:id/canvases`、`/canvases/:id`
- `POST /projects/:id/tasks`（人工意图）与 `POST /projects/:id/events`（幂等事件）都由 Hub 接收
- `GET /jobs`、`POST /jobs/:id/cancel|resume`
- `GET /findings`（severity / verify_status / project_id 筛选）
- 设置：`/agent-roles`、`/role-configs/global`、`/skill-sources`、`/projects/:id/settings`
- 画布：只读渲染，`nodesDraggable={false}`；MVP 5s 轮询；Job 实时流走 `/ws`

## 开发

```bash
pnpm --filter @dfh/web dev   # :5173，代理 /api → :3100
```
