# 语言服务器能力模块（#604）

> **状态：as-built（phase 1）**。镜像工具手册见 [`RUNTIME_TOOL_MANUALS.md`](RUNTIME_TOOL_MANUALS.md)；镜像选型见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)。

DeepSonar 将语言服务器建模为**受治理、可插拔**的 Agent 能力模块，与 Capability Pack（Skill 契约信封）并列登记，但使用独立 schema `deepsonar.language-server-capability/v1`。

## Phase 1：`language-server.clangd`

| 字段 | 值 |
| --- | --- |
| id | `language-server.clangd` |
| languages | `c`, `cpp` |
| server | `clangd`（版本绑定审计镜像） |
| compatible_images | `deepsonar-chrome-audit`, `deepsonar-clickhouse-audit` |
| requires | `compile_commands.json` |
| operations | `definition` / `references` / `hover` / `document_symbol` / `workspace_symbol` / `diagnostics` |
| read_only / network | `true` / `disabled` |
| limits | 调用次数、超时、响应字节上限（见目录元数据） |

## 控制面流程

1. **目录**：`list_capabilities` / `describe_capability` 返回 `language-server.clangd`；`describe_capability` 额外附带完整 `language_server` 元数据。
2. **Hub**：只能引用目录中已登记能力；`list_available_runtime_images` 的 chrome/clickhouse audit 条目能力标签含 `language-server.clangd`。
3. **Scheduler 校验**：`admitLanguageServerCapability` 对未登记、镜像不兼容、缺 `compile_commands.json`、或运行时安装请求返回结构化 `capability_unavailable`（不得静默降级为裸 `clangd` shell）。
4. **Job 快照**：兼容审计镜像在创建 Job 时冻结 `language_server`（id / version / image_key / config_fingerprint / limits）。
5. **Adapter**：`agent-harness/language-server-adapter.mjs` 仅暴露受控操作；限制超时、调用次数、响应大小与工作区路径沙箱。结果 schema 为 `deepsonar.language-server-result/v1`，`is_finding: false`。

## 非目标（本阶段）

- 不为全部镜像预装语言服务器；禁止 Job 内 `apt`/`npm` 安装 LSP。
- 不接入 gopls / rust-analyzer / pyright。
- 不把 diagnostics 提升为安全 Finding；不开放 `codeAction` / workspace edits。

## 测试

```bash
pnpm ci:unit:language-server
node agent-harness/test-language-server-adapter.mjs
```
