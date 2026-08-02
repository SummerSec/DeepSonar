# 用户认证机制（已实现）

> 状态：已落地（schema v8）  
> 与 `api_tokens` 服务账号并存：人用账号登录，服务/自动化用 API Token。

## 能力

| 能力 | 说明 |
|------|------|
| 用户名 + 密码 | scrypt 哈希，盐随机 |
| 会话 Token | `deepsonar_user_<env>_<prefix>_<secret>`，7 天，可吊销 |
| 角色 | `admin` / `operator` / `viewer` |
| 首次引导 | 无用户时 `POST /auth/bootstrap` 创建管理员 |
| Web 登录页 | `/login`；`DEEPSONAR_AUTH_REQUIRED=true` 时强制 |
| 用户管理 | Agent 管理 → 用户（admin） |

## API

```
GET  /auth/status          # 是否强制鉴权、是否可 bootstrap
POST /auth/bootstrap       # 仅无用户时
POST /auth/login
POST /auth/logout
GET  /auth/me
POST /auth/change-password
GET  /users                # admin
POST /users
PATCH /users/:id
POST /users/:id/password
```

## 启用

```env
DEEPSONAR_AUTH_REQUIRED=true
```

1. 打开 Web `/login`  
2. 首次：创建管理员  
3. 之后：账号密码登录（或粘贴 API Token）

本地开发可保持 `DEEPSONAR_AUTH_REQUIRED=false`（免登录；若带 Bearer 仍解析真实用户）。

## 角色权限（摘要）

- **admin**：全部  
- **operator**：项目/任务/Job/Finding/Agent/导入导出读写  
- **viewer**：只读  

## 未做

- OIDC / SSO / 2FA  
- 项目级成员 ACL（当前用户为全平台角色）  
- 会话列表管理 UI  
