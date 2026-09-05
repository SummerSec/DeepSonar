# Management Skill 推荐权限（最小 Scope）

在 Web「设置 → Token」或 `POST /tokens` 创建 Token。  
Scope 全集以运行时为准：

```bash
curl -s "$DEEPSONAR_BASE_URL/schema?format=summary" | jq .auth.scopes
# 或见 apps/scheduler/src/auth.ts 的 ALL_SCOPES
```

当前全集：

```text
projects:read / projects:write
tasks:read / tasks:write
jobs:control
findings:read / findings:write
assets:read / assets:write / assets:manage
skills:read / skills:write
agents:read / agents:write        # 角色、RoleConfig、设置、凭据
images:read / images:manage / images:approve
tokens:manage
exports:read / exports:write
imports:read / imports:write
admin
```

**没有**独立的 `roles:*` / `credentials:*` scope；角色与凭据都走 `agents:*`。镜像市场独立使用 `images:*`。

按用途选以下组合，**不要全给**：

## 基础管理（CI 日常：建项目/任务、看结果、控 Job）

```text
projects:read
projects:write
tasks:read
tasks:write
jobs:control
findings:read
findings:write
```

- `jobs:control` 覆盖 cancel / resume（旧冻结快照）/ rerun-current（当前配置重冻）/ priority / 任务 pause/start/重试 / 报告重试 / Fact 人工验证。
- 画布广播与人工消息账本读取使用 `tasks:read`；发送人工消息使用 `tasks:write`，引用附件时还需要 `assets:read`。

## 按需追加

| 场景 | 追加 scope |
| --- | --- |
| 查看/改角色注册表、RoleConfig、全局/项目设置、凭据 | `agents:read`、`agents:write` |
| 查看 Provider 目录/详情/影响/兼容性/缓存模型 | `agents:read` |
| 创建/改/轮换/测试 Credential、刷新模型目录、批量绑定 | `agents:write` |
| 管理 Skill 模块源（同步/信任审批） | `skills:read`、`skills:write` |
| 查看镜像市场 | `images:read` |
| 导入镜像、重扫、项目启停/固定版本 | `images:manage` |
| 批准、拒绝、禁用或撤销镜像版本 | `images:approve`（只给平台管理员） |
| 查看/下载项目与 Finding 共享资产 | `assets:read` |
| 上传/归档项目与 Finding 共享资产、修改项目 opt-in | `assets:write` |
| 管理平台共享资产 | `assets:manage`（只给平台管理员；隐含 assets read/write） |
| 创建/查看/下载/取消项目或平台数据包 | `exports:read`、`exports:write` |
| 上传/预览/应用/取消数据包 | `imports:read`、`imports:write` |

## 豁免鉴权（无需 Token）

```text
/health
/openapi.json
/schema
/schema.md
/gateway/*
/auth/status、/auth/login、/auth/bootstrap
```

外部 Agent **应先拉 schema** 再调业务 API，避免硬编码过期路径。

`/ws` 与 `/terminal-ws` 绕过普通 Bearer hook，但并非匿名访问：浏览器先用已认证会话或 Token 调 `POST /auth/ws-ticket`，再携带一次性 ticket 建立连接。

## 红线（绝不授予外部 Agent）

- `tokens:manage` —— Token 创建/吊销/轮换，留给人类管理员；
- `admin` —— 隐式全部 scope，含 `/audit-logs`；
- Credential **明文任何路径都读不到**；`agents:write` 仅在确需自动化登记/轮换凭据时再给。
- `images:approve` 可把第三方代码变成可执行环境，与 `admin` 同样只给人类平台管理员。
- 平台共享资产除 `assets:manage` 路由 scope 外还要求 admin actor，可向所有 opt-in 项目注入文件，只给人类平台管理员。

## 其它约束

- 绑定到**单个项目**（`project_id`）时 Token 只能操作该项目，推荐做法；
- Token 只在创建时展示一次；泄露立即吊销并轮换；
- 建议 `expires_in_days`（如 30/90 天）。

## 创建示例

```bash
# 日常 CI
curl -X POST $DEEPSONAR_BASE_URL/tokens \
  -H "Authorization: Bearer $DEEPSONAR_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "ci-management",
    "scopes": ["projects:read","projects:write","tasks:read","tasks:write","jobs:control","findings:read"],
    "project_id": "<可选：绑定单项目>",
    "expires_in_days": 90
  }'

# 需要改 RoleConfig / 规则 / 凭据模型目录
curl -X POST $DEEPSONAR_BASE_URL/tokens \
  -H "Authorization: Bearer $DEEPSONAR_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "role-config-bot",
    "scopes": ["projects:read","agents:read","agents:write","skills:read","images:read"],
    "expires_in_days": 30
  }'

# 镜像市场运维（不含 approve）
curl -X POST $DEEPSONAR_BASE_URL/tokens \
  -H "Authorization: Bearer $DEEPSONAR_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "image-ops",
    "scopes": ["images:read","images:manage","projects:read"],
    "expires_in_days": 30
  }'
```

## 应急引导

- `DEEPSONAR_ADMIN_TOKEN`：环境变量引导管理员（不落库，`scopes=admin`），用于首次建 Token / 本地脚本；**不要**写进仓库或长期脚本日志。
- 用户会话：`POST /auth/login` → `deepsonar_user_*`；无用户时 `POST /auth/bootstrap`。
- `DEEPSONAR_AUTH_REQUIRED=false` 时本机无 Bearer 以 `internal` 全权运行——仅限回环开发。
