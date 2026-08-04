# 用户认证机制（已实现）

> 状态：已落地（schema v12）
> 与 `api_tokens` 服务账号并存：人用账号登录，服务/自动化用 API Token。

## 能力

| 能力 | 说明 |
|------|------|
| 用户名 + 密码 | scrypt 哈希，盐随机 |
| 会话 Token | `deepsonar_user_<env>_<prefix>_<secret>`，7 天，可吊销 |
| 角色 | `admin` / `operator` / `viewer` |
| 首次账号 | 空库启动时自动创建 `admin` / `Deep@Sonar66`（scrypt；只创建一次） |
| 兼容引导 | `POST /auth/bootstrap` 保留给旧客户端；默认种子存在时返回 409 |
| Web 登录页 | `/login`；`DEEPSONAR_AUTH_REQUIRED=true` 时强制 |
| 用户管理 | Agent 管理 → 用户（admin） |

## API

```
GET  /auth/status          # 是否强制鉴权、是否可 bootstrap
POST /auth/bootstrap       # 兼容旧客户端；默认种子存在时 409
POST /auth/login
POST /auth/logout
GET  /auth/me
POST /auth/change-password
POST /auth/change-username
GET  /users                # admin
POST /users
PATCH /users/:id
POST /users/:id/password
```

## 启用

```env
DEEPSONAR_AUTH_REQUIRED=true
```

1. 打开 Web `/login`。空库首次启动可直接使用 `admin` / `Deep@Sonar66` 登录（或旧客户端调用 bootstrap）。
2. 生产 / 公网部署必须立即修改密码，并建议同时修改登录名；该默认口令已公开，不应视为秘密。
3. 之后使用新账号密码登录（或粘贴 API Token）。

本地开发可保持 `DEEPSONAR_AUTH_REQUIRED=false`（免登录；若带 Bearer 仍解析真实用户）。

## 账号修改与会话策略

- `POST /auth/change-password` 需要当前密码；密码使用 scrypt 重新加盐哈希，旧密码立即失效。
- `POST /auth/change-username` 需要当前密码；用户名按唯一约束校验，冲突返回 `409 USERNAME_TAKEN`。
- 两种修改都会吊销该用户的全部旧会话，并返回一个新的会话 Token；API Token 不受影响。
- 首次种子、改密、改登录名都会写入 `audit_logs`，只记录用户名/角色等安全元数据，不写密码、盐、哈希或 Token。
- `/auth/status.default_admin_credentials_active` 只有默认 `admin` 账号仍使用公开初始口令时才为 `true`；登录页据此显示一次性提示，改名或改密后自动隐藏。

## 角色权限（摘要）

- **admin**：全部  
- **operator**：项目/任务/Job/Finding/Agent/导入导出读写  
- **viewer**：只读  

## 未做

- OIDC / SSO / 2FA  
- 项目级成员 ACL（当前用户为全平台角色）  
- 会话列表管理 UI  
