# Management Skill 推荐权限（最小 Scope）

在 Web「设置 → Token」或 `POST /tokens` 创建 Token。  
Scope 全集以运行时为准：

```bash
curl -s "$DFH_BASE_URL/schema?format=summary" | jq .auth.scopes
# 或见 apps/scheduler/src/auth.ts 的 ALL_SCOPES
```

当前全集：

```text
projects:read / projects:write
tasks:read / tasks:write
jobs:control
findings:read
skills:read / skills:write
profiles:read / profiles:write    # 角色、RoleConfig、设置、凭据
integrations:read / integrations:write
tokens:manage
admin
```

**没有**独立的 `roles:*` / `credentials:*` scope；角色与凭据都走 `profiles:*`。

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

- `jobs:control` 覆盖 cancel / resume / priority / 任务重试 / 报告重试 / fact 人工验证。

## 按需追加

| 场景 | 追加 scope |
| --- | --- |
| 查看/改角色注册表、RoleConfig、全局/项目设置、凭据 | `profiles:read`、`profiles:write` |
| 管理 Skill 模块源（同步/信任审批） | `skills:read`、`skills:write` |
| 绑定/同步 Plane | `integrations:read`、`integrations:write` |

## 豁免鉴权（无需 Token）

```text
/health
/openapi.json
/schema
/schema.md
/webhooks/plane
/gateway/*
```

外部 Agent **应先拉 schema** 再调业务 API，避免硬编码过期路径。

## 红线（绝不授予外部 Agent）

- `tokens:manage` —— Token 创建/吊销/轮换，留给人类管理员；
- `admin` —— 隐式全部 scope，含 `/audit-logs`；
- Credential **明文任何路径都读不到**；`profiles:write` 仅在确需自动化登记/轮换凭据时再给。

## 其它约束

- 绑定到**单个项目**（`project_id`）时 Token 只能操作该项目，推荐做法；
- Token 只在创建时展示一次；泄露立即吊销并轮换；
- 建议 `expires_in_days`（如 30/90 天）。

## 创建示例

```bash
# 日常 CI
curl -X POST $DFH_BASE_URL/tokens \
  -H "Authorization: Bearer $DFH_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "ci-management",
    "scopes": ["projects:read","projects:write","tasks:read","tasks:write","jobs:control","findings:read"],
    "project_id": "<可选：绑定单项目>",
    "expires_in_days": 90
  }'

# 需要改 RoleConfig / 规则
curl -X POST $DFH_BASE_URL/tokens \
  -H "Authorization: Bearer $DFH_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "role-config-bot",
    "scopes": ["projects:read","profiles:read","profiles:write","skills:read"],
    "expires_in_days": 30
  }'
```
