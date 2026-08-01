# DeepFlowHunter Management API 契约

Base URL：`DFH_BASE_URL`（默认 `http://localhost:3100`）
认证：`Authorization: Bearer <dfh_token>`（`DFH_AUTH_REQUIRED=false` 时本地回环可省略）

## 端点一览（Management Skill 使用面）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 健康检查（免鉴权） |
| GET | /projects | 项目列表 |
| POST | /projects | 创建项目 `{name, description?}` |
| GET | /projects/:id | 项目详情 |
| PATCH | /projects/:id | 更新项目（部分字段） |
| POST | /projects/:id/archive | 归档项目 |
| POST | /projects/:id/tasks | 创建任务 `{title, content?, module_path? | repo_url? | repo_path?, ref?}` → 幂等，返回 job/canvas |
| POST | /tasks/:canvasId/retry | 同画布重试（复用同一 canvas） |
| POST | /projects/:id/events | 注入外部事件 `{source, event_id, event_type, title?, content?, data?}`，`source+event_id` 幂等 |
| GET | /jobs?project_id= | Job 列表 |
| GET | /jobs/:id | Job 详情（含事件） |
| PATCH | /jobs/:id/priority | 调整 pending 优先级 `{priority}` |
| POST | /jobs/:id/cancel | 取消（running 会回收沙箱） |
| POST | /jobs/:id/resume | 恢复 cancelled → pending（终态 409） |
| GET | /findings?project_id= | Finding 列表 |
| GET | /projects/:id/canvases | 画布列表（一次任务 = 一个画布） |
| GET | /canvases/:id | 画布节点/边 |
| PUT | /projects/:id/integrations/plane | 绑定 Plane `{plane_project_id}` |
| DELETE | /projects/:id/integrations/plane | 解绑 Plane |
| POST | /projects/:id/integrations/plane/sync | 手动触发同步 |
| GET | /global-settings | 全局配置 |

## 错误格式

```json
{ "error": "人类可读信息" }
```

- 400：参数/Zod 校验失败
- 401：未认证或 Token 无效/过期/已吊销
- 403：Scope 不足或项目级 Token 跨项目访问
- 404：资源不存在
- 409：冲突（同名、终态 resume、唯一约束）
- 502：上游失败（Git 同步、Plane 不可达等）

## 幂等

- 任务创建走 `jobs.ingress_key` 唯一约束：同一 project + 同一标题/source+event_id 重复提交返回既有 Job，不重复执行。
- 事件注入走 `(project_id, source, event_id)` 幂等键。
