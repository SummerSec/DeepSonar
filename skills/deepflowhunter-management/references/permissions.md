# Management Skill 推荐权限（最小 Scope）

在 Web「设置 → Token」或 `POST /tokens` 创建 Token。Scope 全集见 `apps/scheduler/src/auth.ts` 的 `ALL_SCOPES`。
按用途选以下组合，**不要全给**：

## 基础管理（CI 日常：建项目/任务、看结果、控 Job）

```text
projects:read
projects:write
tasks:read
tasks:write
jobs:control
findings:read
```

- `jobs:control` 覆盖 cancel / resume / priority / 任务重试 / 报告重试 / fact 人工验证，
  但**不允许**绕过状态机直改状态（API 本身无此端点）。

## 按需追加

| 场景 | 追加 scope |
| --- | --- |
| 查看/覆盖角色配置（RoleConfig） | `roles:read`（只读）、`roles:write`（改角色与配置） |
| 查看/修改全局或项目设置（rules、角色启停） | `profiles:read`、`profiles:write` |
| 管理 Skill 模块源（同步/信任审批） | `skills:read`、`skills:write` |
| 绑定/同步 Plane | `integrations:read`、`integrations:write` |

## 红线（绝不授予外部 Agent）

- `tokens:manage` —— Token 创建/吊销/轮换，属管理面，留给人类管理员；
- `admin` —— 隐式拥有全部 scope，含 `/audit-logs` 与未列入 scope 表的一切写操作；
- Credential 明文任何路径都读不到（API 不返回），`credentials:*` 写操作（profiles:write）只在确需自动化轮换时才给。

## 其它约束

- 绑定到**单个项目**（`project_id`）时，Token 只能操作该项目，是推荐做法；
- 需要跨项目管理的 CI 可不绑项目，但 scope 仍应保持最小；
- Token 只在创建时展示一次；泄露立即吊销（`POST /tokens/:id/revoke`）并轮换（`POST /tokens/:id/rotate`）；
- 建议设置 `expires_in_days`（如 30/90 天）让 Token 自然过期。

## 创建示例

```bash
curl -X POST $DFH_BASE_URL/tokens \
  -H "Authorization: Bearer $DFH_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "ci-management",
    "scopes": ["projects:read","projects:write","tasks:read","tasks:write","jobs:control","findings:read"],
    "project_id": "<可选：绑定单项目>",
    "expires_in_days": 90
  }'
```
