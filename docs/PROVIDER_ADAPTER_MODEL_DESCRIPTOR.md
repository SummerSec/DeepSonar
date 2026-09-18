# Provider Adapter & Model Descriptor (#614)

## 定位

平台控制面（#568）只做 Provider 启用 / 配额 / 审计；运行时 AI（Hub）按结构化 Model Descriptor 选型。本文件描述 phase-1 契约，不把身份锁死在角色上。

## 契约

| Schema | 用途 |
| --- | --- |
| `deepsonar.provider-adapter/v1` | Adapter Registry 行：凭据校验钩子形状、目录发现、CLI 兼容、Gateway transform stub |
| `deepsonar.model-descriptor/v1` | 结构化模型能力（context / tools / streaming / structured_output / reasoning / modalities / cost / rate_limits / health / catalog_revision） |
| `deepsonar.provider-model-snapshot/v1` | Job 冻结：adapter 版本 + route + cli/upstream model id + descriptor + catalog revision |

## 健康态

`verified` | `stale` | `probe_failed` | `unsupported` | `passthrough_allowed`

默认 **不是** `passthrough_allowed`。透传须项目级 / 平台开关显式打开，并写入 Job 快照。

## Credential vs RoleConfig

`Credential.agent_cli` 仅为软提示。Agent CLI、模型 Profile、reasoning 属于 RoleConfig（或 Role-Credential Binding）。同一 Credential 可被多个不同 Agent CLI 的角色复用；保存一个 RoleConfig **不应**改写 Credential 的全局运行语义（phase-1 仍保留历史 follow 写回以兼容集成测试，迁移见 CHANGELOG deferred）。

## Phase-1 vs 延期

已交付：契约、Registry 种子、选型 helper、Job `provider_model` 冻结、Gateway 仅允许冻结模型、单测。

延期：全量 Provider 接入、真实 probe 全部迁入 Adapter、停止 RoleConfig→Credential.agent_cli 回写、Web 健康态 UI、Fallback / 并发限制集成测试扩面。
