# 方案：凭据配置回显 bug 修复 + 镜像市场内置注册表

> 状态：已实施（2026-08-03）。本文件为实施方案与验收记录。

## Context（为什么改）

两个独立改动，用户在同一轮提出：

1. **凭据配置回显 bug**：用户在凭据页手动填写的「模型 ID + 单模型并发 + 总并发」，保存后再次编辑时无法获取/回显已配置的值。这类配额存于 `credentials.public_metadata_json`（`allowed_model_ids` / `model_concurrency` / `max_concurrent`），是 RoleConfig 选模型和调度并发的依据，回显失败会让人误以为没存上、反复重填。

2. **镜像市场内置注册表**：当前官方镜像依赖 `DEEPSONAR_OFFICIAL_*_IMAGE` 环境变量注入 GHCR digest，第三方导入必走 admission Worker 扫描（需 docker pull/scan，本机 docker 不可用直接卡死）。用户要求：本项目**内置一份镜像清单文件**（开箱即用、不依赖 env）、**通过 API 实时获取清单最新内容**、提供**批量拉取脚本**在有 docker 的机器本地搭建镜像、并支持**手动添加容器镜像**（填 digest 免扫描直接可用）。

---

## Part A：凭据配置回显 bug 修复

### 现状（代码审查结论）
- 模型/并发存 `credentials.public_metadata_json`。后端 `normalizeCredentialMeta`（`apps/scheduler/src/routes.ts:2521`）保存时**保留** `allowed_model_ids`、`max_concurrent`、`model_concurrency`（且强制 `model_concurrency` 的 keys = `allowed_model_ids`）。
- 并发策略 `credentialConcurrencyPolicy`（`apps/scheduler/src/credentials.ts:100`）按 `allowed_model_ids` 构造，缺失项按 1 补。
- 前端 `CredentialsPanel.startEdit`（`apps/web/src/CredentialsPanel.tsx:129-144`）回显：
  - `editMaxConcurrent = metaMaxConcurrent(c)?.toString() ?? ""`
  - `editModelLimits = Object.fromEntries(metaAllowedModels(c).map(m => [m, String(limits[m] ?? 1)]))`
- 保存（`saveEdit` `:185-218`）：`allowed_model_ids` = `Object.keys(editModelLimits)`，`model_concurrency` 同 keys 对应值，整体替换 `public_metadata_json`。

### 根因判断
两端在大体上对称，因此「无法获取已配置」是**边界场景**，最可能：
1. **回显只遍历 `allowed_model_ids`**：若任何历史/异常状态下 `model_concurrency` 含 `allowed_model_ids` 之外的 key（或反之），回显会丢模型。
2. **总并发 0 值**：`metaMaxConcurrent`（`:68-71`）对 0 返回 0、对缺失返回 null，回显语义需确认 0 不被当空。
3. 手动添加模型（`addManualModel` `:169`）后未触发 `allowed_model_ids` 刷新的某些时序。

→ **实施第一步必须复现**：手动填模型 ID + 单模型并发 + 总并发 → 保存 → 重新打开编辑 → 观察具体哪些字段没回显，再精修。

### 修复
- **防御性回显**：`editModelLimits` 的 keys 取 `allowed_model_ids ∪ Object.keys(model_concurrency)` 并集，避免任何状态下丢模型。
- 确认 `metaMaxConcurrent` 对 0/缺失的回显正确（0 回显 "0"，缺失回显 ""）。
- 据复现结果针对性修（若 UI 渲染时序问题，则修模型列表渲染）。

### 关键文件
- `apps/web/src/CredentialsPanel.tsx`（`startEdit` 回显 `:129-144`，必要时 UI 渲染逻辑）

---

## Part B：镜像市场内置注册表

### B1 仓库静态清单文件
新增 `deploy/runtime-image-registry.json`，schema `deepsonar.registry/v1`，列三个官方镜像（base/audit/kali-minimal）：
```json
{
  "schema": "deepsonar.registry/v1",
  "images": [
    { "image_key": "deepsonar-base", "name": "...", "description": "...", "publisher": "SummerSec",
      "source_kind": "official", "project_opt_in": false, "default_role": "base",
      "versions": [{ "version": "...", "image_ref": "ghcr.io/.../deepsonar-base@sha256:...", "tools_manifest_sha256": "...", "platforms": ["linux/amd64"], "size_bytes": 0 }] }
  ]
}
```
digest 从现有 CI 产物 / `DEEPSONAR_OFFICIAL_*_IMAGE` 当前值固化写入。

### B2 bootstrap 读取清单（不再强依赖 env）
改 `apps/scheduler/src/runtime-images.ts` 的 `bootstrapOfficialRuntimeImages()`（:42-114）：
- 读取 `deploy/runtime-image-registry.json`（相对 `process.cwd()`，便于 `node dist/` 与 dev 两种跑法）。
- 对每 image：upsert `runtime_images`（`source_kind='official'`, `official=true`）。
- 对每 version（`@sha256:`）：upsert `runtime_image_versions`（`trust_status='trusted'`），跳过可移动 tag。
- `DEEPSONAR_OFFICIAL_*_IMAGE` env 保留作**可选覆盖**（向后兼容）。

### B3 API 导出清单（用户强调"通过 API 获取最新内容"）
新增 `GET /runtime-images/registry`（`apps/scheduler/src/routes.ts`）：
- 返回当前清单解析结果（或 DB `runtime_images` + 最新 trusted version 的并集 JSON）。
- 鉴权：需 Bearer token（与 `/runtime-images` 一致，生产已开鉴权）。
- 前端 `apps/web/src/api.ts` 加 `api.runtimeImagesRegistry()`；`RuntimeImagesPage` 顶部加「导出清单」/显示清单入口。

### B4 批量拉取脚本（"抓取镜像在本地搭建"）
新增 `deploy/pull-runtime-images.sh`：
- 优先 `curl` 调 `GET /runtime-images/registry`（带 token），退化直接读 `deploy/runtime-image-registry.json`。
- 对每个 version 的 `image_ref` 执行 `docker pull`，输出成功/失败汇总。
- 用法：`DEEPSONAR_URL=… DEEPSONAR_TOKEN=… ./deploy/pull-runtime-images.sh`，或 `./deploy/pull-runtime-images.sh --file deploy/runtime-image-registry.json`。

### B5 手动添加镜像（填 digest 免扫描，适合本机/无 admission）
- 复用现有 `POST /runtime-images/:id/official-digest`（`:1034`）的「填 `@sha256:` 直接 trusted」逻辑，**放宽到非 official 镜像**：新增端点 `POST /runtime-images/manual-digest`（或扩展 import 表单带 `trust_immediately` 选项 + digest）。
- 前端 `RuntimeImagesPage` 导入表单（`:220-284`）增加「手动信任登记」路径：填 `image_key` / `image_ref@sha256` / 元数据 → 直接 `trusted`，不走 `runtime_image_scans` 队列。
- registry 仍须在 `DEEPSONAR_ALLOWED_IMAGE_REGISTRIES` 允许列表内。

### 关键文件
- 新增 `deploy/runtime-image-registry.json`
- 新增 `deploy/pull-runtime-images.sh`
- 改 `apps/scheduler/src/runtime-images.ts`（bootstrap 读清单）
- 改 `apps/scheduler/src/routes.ts`（`GET /runtime-images/registry` + 手动登记端点）
- 改 `apps/web/src/pages/RuntimeImagesPage.tsx`（手动登记 UI + 清单入口）
- 改 `apps/web/src/api.ts`（新 API 客户端）

---

## 实施步骤

0. ~~把本方案落成 `docs/` 文档~~ —— 已完成（本文件）。
1. ~~**Part A**：复现 bug → 修 `CredentialsPanel.startEdit` 防御性回显 → 重新编辑验证全字段回显。~~
2. ~~**Part B**：建清单文件 → 改 bootstrap → 加 API 导出端点 → 加拉取脚本 → 加手动登记 → 各端验证。~~
3. ~~每步 `pnpm build` 过类型；改后端需 `restart` 生产 scheduler（`deploy/local-daemon.sh restart`）。~~

## 验证
- **Part A**：凭据页手动填 模型 ID + 单模型并发(如 3) + 总并发(如 5) → 保存 → 重新打开编辑 → 三项全回显；0 并发也回显 "0"。
- **Part B**：
  - 清单文件存在且 schema 校验通过。
  - scheduler 启动日志显示从清单注入官方镜像；`runtime_images` 表有对应 trusted version。
  - `GET /runtime-images/registry`（带 admin token）返回清单 JSON。
  - `deploy/pull-runtime-images.sh`、`deploy/prepare-runtime-images.sh` 的后台拉取/逐项构建、失败回退、日志和原子锁已验证；本机 Docker rootless 缺少 `newgidmap`，真实构建未成功，未将本地 image ID 冒充 digest。
  - `deploy/local-daemon.sh` 会先轮询 scheduler health，最长约 30 秒后再后台启动准备流程；失败只记录，不阻断服务启动。
  - 启动后支持异步读取 API/静态 registry、按内置 image key 拉取或构建 local tag；仅显式设置 `DEEPSONAR_RUNTIME_IMAGE_GIT_PULL=true` 且 worktree clean 时执行 `git pull --ff-only`。
  - 手动登记一个 `@sha256:` 镜像 → 立即 `trusted`、无 scan 记录、RoleConfigEditor 镜像下拉可选。
  - 静态清单中的官方真实 digest 仍为空；`AGENT_MODE=real` 必须通过 `DEEPSONAR_OFFICIAL_*_IMAGE` 或官方登记接口提供不可变 digest。
