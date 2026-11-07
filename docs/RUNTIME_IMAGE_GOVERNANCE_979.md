# 旧运行镜像治理契约：诊断与恢复（#979）

> 状态：**代码修复与 OCI 内容核验；正式 Release/线上目录恢复未完成**。
> 同步日期：2026-11-07

## 根因和影响

当前平台的 DSH profile 使用镜像内 `deepsonar-index.js`，而官方目录仍提供的 `deepsonar-base:0.6.4` 没有该入口。Cordis 插件加载失败后没有注册 provider route，因此 `no adapter registered for provider` 并不说明 Provider 账号的 route 名配置错误。

同类检查结果：

- **DSH**：启动前校验当前预算插件 manifest、vendor/artifact/helper 内容和 SDK 版本；缺失或陈旧返回 `DSH_REQUEST_BUDGET_IMAGE_CONTENT_INVALID`，不启动 CLI，不回退未受治理的 vendor adapter。
- **Pi 主请求**：预算扩展由 `runtime-agent` 每次启动上传，不依赖 DSH 插件入口。
- **Pi 可选 Observational Memory**：wrapper 固化在镜像内。旧 wrapper 不提供当前 Gateway 要求的 `x-deepsonar-request-id`，后台请求会被 `missing_gateway_request_id` 拒绝。新 OM Job 最低镜像版本更新到 `0.6.15`；每次启动/恢复还要求 wrapper 的 SHA-256 与当前源码一致。旧冻结 Job 不重新写快照，不能只靠新建时的版本下限解决。
- **Claude Code**：请求包装由 `runtime-agent` 上传，未发现 DSH/OM 这条镜像内组件滞后的相同根因。这不是对 Claude 全部行为或真实模型的验收结论。

## 已核实的发布状态

[v0.6.15 的发布运行](https://github.com/SummerSec/DeepSonar/actions/runs/42178680573)失败于 Chrome / ClickHouse 子镜像，未完成最终 catalog、签名和正式 Release。部分 runtime/platform 镜像 tag 已存在不代表整版发布成功。最新正式版仍为 v0.6.14，`releases/latest` 的目录仍是旧目录；仓库 `deploy/runtime-image-registry.json` 和部署示例保持正式回写基线，不将失败发布的三个镜像条目冒充完整 Release。

以下三个运行镜像已实际推送。2026-11-07 通过只读 OCI API 核验 GHCR、Docker Hub、ACR 的九个 index 与 canonical digest 一致，并对六份 amd64/arm64 完整压缩 rootfs layer 校验 SHA-256；只读取 tar 文件，不执行镜像、真实模型或生产任务。

| 运行镜像 | canonical index digest | 两平台压缩层大小上限 |
| --- | --- | ---: |
| deepsonar-base | `sha256:7f682a1a33f17fd2ff666027ce30b582aa0df36bc93536f7b003e72ade9dd0ca` | 490613179 |
| deepsonar-audit | `sha256:3dfc2b472d084c972432a1ae0a7d7e8ba622e6fc4d5ce6f79f2bc06c2bbc1476` | 509713393 |
| deepsonar-kali-minimal | `sha256:ccee63dc1692c22df9d048ca8ac8db7b7a207266e8ba81910a243f68d1b1bda8` | 1682960610 |

这六份镜像内 DSH helper 的实际 SHA-256 与 manifest、当前源码字符串相同，为 `c1f1f425fa085b70ece08df84c36fbb139e5f69cb4f5354378ec3f247cfdae92`。DSH plugin 版本为 `0.2.1-rc.2`，其 SDK 为 `1.4.0`。六份 OM wrapper 的 SHA-256 为 `a1facb1ceb9d6b985443cd6bd5c534607638e5973fdfdedb8a4485c659a92761`，包含 allowance、request-id 与 settlement 契约。OM 自身的独立 SDK 不与 DSH SDK 混同。

手册摘要须使用经过 layer 验证的 `tool-manifest.manual.sha256` / `index.manual_sha256`，不能使用 `index.json` 的文件字节哈希。三款 manual version 均为 `2026-10-28`：

| 运行镜像 | catalog manual.sha256 | count |
| --- | --- | ---: |
| deepsonar-base | `06b3e50c2e60ccbd4e5f27099edbc383f941386aacbf66df1c2468a321f5e1aa` | 58 |
| deepsonar-audit | `158affb6fb0d8b73a01973acc64daddf96ad30c263e9b9412e6c285686957652` | 60 |
| deepsonar-kali-minimal | `92ab80310bead30bdb3d439190347d9aed3cc92c32a0769febcd5653c5e86d2c` | 73 |

例如 issue 中 base 的 `3eb8ecc5e712de2d87798dfce908d257f61714cc14c15a9fcdfaddea4f9f9174` 是 index 文件字节哈希，不是这里的语义集合摘要。此次核验读取已验证 layer 内的元数据，未独立重算全部手册 Markdown 集合；OCI 内容证据不替代各平台运行 smoke、签名或最终 SHA Actions。

## 恢复步骤与限制

**持久恢复走正式发布。** 在修复提交通过完整适用 Actions 后，由有授权的操作者按[发布流程](RELEASE_RUNTIME_IMAGES.md)完成新的不可变版本，校验完整产品集合、双平台、各通道、签名及 Release 附件，再让 workflow 回写 bundled。不要移动旧 v0.6.15 tag、覆盖已有镜像或只改 `platform_version`。官方目录可用后，执行 `/runtime-images/registry/sync`，拉取对应产品并等待 readiness，随后显式创建新 Job；已有冻结 digest 不自动替换。

**已核验的人工恢复目录只适合受控临时操作。** 现有平台管理员接口 `POST /runtime-images/registry/apply` 可以接受完整 v2 JSON 目录（直接对象或 `{ "registry": ... }`），且 `POST /runtime-images/registry/pull` 可通过 `items` 的 `image_key` / 不可变 `image_ref` 定向拉取。只能使用核验过的通道与摘要，保留正式平台 manifest/version，不虚构平台升级记录。等待 `/runtime-images/registry/pull-status` 和镜像 readiness 后才创建新任务；不得修写旧 Job 快照。

上传目录并非持久覆盖：它只进入当前进程缓存和目录数据库；缓存有效期五分钟，后台自动同步默认一小时，显式同步/自动同步旧 Release 会再次撤销不在远端清单中的版本的 promoted 状态。不能把上传一次作为长期解决方案，也不能通过自动合并旧 bundled 记录、关闭撤销或悄悄改变下载源来绕过远端权威。未完成正式发布前，线上同步恢复仍是开放项。

## 验证与需求映射

- FR-IMG-003 / NFR-SEC-004：DSH 与 OM 镜像内容检查，复用既有不可变镜像与冻结边界，无新 API/schema 或 ADR 决策。
- `pnpm ci:unit:runtime-sandbox`：旧/缺失/篡改 DSH 插件和旧 OM wrapper 拒绝、合格内容正例、启动/恢复前拦截。
- `pnpm ci:unit:credential-compatibility`：OM 专属最低版本准入，其他 Pi 扩展不受影响。
- `pnpm ci:integration:request-budget-sdk`：真实钉死 DSH 安装执行生产内容守卫，删除治理入口时拒绝并恢复正例；上游仍为合成 loopback。
- 文档保鲜、类型检查及其余适用完整 CI 按最终 SHA Actions 验收。本地仅审查 diff/读取 OCI，不运行 tests/build/typecheck；未发布、未部署、未重跑生产或调用真实模型。
