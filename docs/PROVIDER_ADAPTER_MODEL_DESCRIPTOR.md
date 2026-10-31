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

`Credential.agent_cli` 为账号独占 CLI 钉（#658）：账号选定哪个 CLI，就只能给哪个 CLI 用。兼容列表 / 白名单过滤 / 角色绑定 / Job 快照准入均以该字段为唯一来源；缺省或非法 fail-closed，不得再按 Provider 协议矩阵扩到其他 CLI。Provider 级 catalog（协议理论上支持哪些 CLI）仍可用于**创建时** Provider 选择过滤。保存一个 RoleConfig **不应**改写 Credential.agent_cli。

## Phase-1 vs 延期

已交付：契约、Registry 种子、选型 helper、Job `provider_model` 冻结、Gateway 仅允许冻结模型、单测；#658 账号 CLI 独占绑定。

延期：全量 Provider 接入、真实 probe 全部迁入 Adapter、Fallback / 并发限制集成测试扩面。
