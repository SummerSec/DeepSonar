# 通用 CLI 基础能力包（#611）

> **状态：as-built（phase 1）**。镜像工具手册见 [`RUNTIME_TOOL_MANUALS.md`](RUNTIME_TOOL_MANUALS.md)；镜像选型见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)；语言服务器能力见 [`LANGUAGE_SERVER_CAPABILITIES.md`](LANGUAGE_SERVER_CAPABILITIES.md)。

DeepSonar 将通用命令行工具建模为**受治理、可插拔**的 Agent 能力模块，与 Capability Pack（Skill 契约信封）及语言服务器模块并列登记，但使用独立 schema `deepsonar.cli-capability/v1`。

## Phase 1 能力目录

| 能力 ID | 工具 | 默认可用 | 说明 |
| --- | --- | --- | --- |
| `text.search.rg` | `rg` | 是 | 源码/配置/日志文本搜索 |
| `file.discovery.fd` | `fd` / `fdfind` | **否** | 目录已登记；镜像 apt 钉死（`fd-find`）为后续切片 |
| `json.query.jq` | `jq` | 是 | JSON 查询与转换 |
| `yaml.query.yq` | `yq` | **否** | 目录已登记；无干净 mikefarah 钉死策略前不装入基础镜像 |
| `source.control.git` | `git` | 是 | 版本、提交、差异与历史 |
| `file.inspect.file` | `file` | 是 | 文件类型提示 |
| `evidence.hash.sha256sum` | `sha256sum` | 是 | 证据摘要（base 镜像 coreutils） |
| `patch.diff` | `diff` / `patch` | **否** | 目录已登记；`diffutils`/`patch` apt 钉死为后续切片 |
| `execution.timeout` | `timeout` | 是 | 限制命令墙钟时间（coreutils） |
| `archive.extract` | `tar` / `unzip` / `xz` | 是 | 解压与检查交付物 |

专项工具 `strings` / `readelf` / `objdump` / `nm` / `sqlite3` / `curl` **不**纳入本基础包；`curl` 继续受网络出口策略控制。

## 控制面流程

1. **目录**：`list_capabilities` / `search_capabilities` / `describe_capability` 返回上表 id；`describe_capability` 额外附带完整 `cli_capability` 元数据。
2. **Hub**：只能引用目录中已登记能力；`list_available_runtime_images` 的 base/audit 条目 `capabilities` 含已默认可用的 CLI 能力 id。Intent 可通过 `cli_capability_ids: string[]` 提案。
3. **Scheduler 校验**：`admitCliCapability` / `admitCliCapabilities` 对未登记、镜像不兼容、工具未上架（`default_available=false`）、或运行时安装请求返回结构化 `capability_unavailable`（不得静默降级为未登记 shell）。
4. **Job 快照**：准入成功后冻结 `cli_capabilities: FrozenCliCapability[]` 与 `cli_capability_pack.pack_fingerprint`。
5. **证据语义**：结果 schema `deepsonar.cli-capability-result/v1` 固定 `is_finding: false`；CLI 输出只作 Evidence/Fact 输入，不可直接升格为安全 Finding，也不可替代 LSP/AST/污点分析。

## 非目标（本阶段）

- 不为全部镜像一次性安装全部工具；禁止 Job 内 `apt`/`npm`/`pip` 或网络下载工具。
- 不把浏览器 / 移动端 / Fuzz / ClickHouse 专项工具并入本包。
- 不在本 PR 重建或推送运行镜像；`fd` / `yq` / `diff`/`patch` 的 Dockerfile 钉死与手册扩写为 follow-up。

## 测试

```bash
pnpm ci:unit:cli-capability
pnpm ci:unit:capability-pack
```
