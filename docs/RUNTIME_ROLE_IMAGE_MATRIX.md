# 角色 × 官方镜像能力矩阵

> **状态：as-built**（#565 / #611 CLI 能力标签）。索引：[`README.md`](README.md)。语言工具链细节见 [`RUNTIME_TEST_TOOLCHAINS.md`](RUNTIME_TEST_TOOLCHAINS.md)；镜像 OCI/catalog 契约见 [`RUNTIME_IMAGE_REGISTRY_CONTRACT.md`](RUNTIME_IMAGE_REGISTRY_CONTRACT.md)。

**主目标（#565）**：让运行时 AI（尤其 Hub）能决定给 Worker 提案哪张运行镜像。权威机器目录是 `list_available_runtime_images` 返回字段（`purpose` / `tool_summary` / `not_included` / `suited_*` / `selection_hints` / `capabilities`），实现于 `apps/scheduler/src/hub-runtime-image-capability.ts`。本文是同源中文矩阵，便于人读；与 harness / Role 默认 / Worker AGENTS 边界漂移时以代码为准并回写本文。

## 注入规则（Scheduler）

`withRuntimeTestToolchainPolicy(role, instructions, resolved_image_key)`：

| 条件 | 注入内容 |
| --- | --- |
| **任意角色**，且冻结镜像属于 13 个官方 key | `### Runtime tool manuals (Scheduler policy)`：先读 `/opt/deepsonar/manuals/index.json`，再按任务读取具体章节；手册不授予权限 |
| 角色 `test`，或 `verify` 且镜像 ≠ `deepsonar-base` | `### Runtime test toolchain (Scheduler policy)`（禁止 Job 内 bootstrap JDK/Maven/…；缺工具 → `inconclusive`/`needs_human`） |
| **任意角色**，且冻结镜像属于官方专项 key（见下表「Scheduler 边界」列） | 对应 chrome / clickhouse / openharmony / mobile 专项能力边界（与 mobile/OH 同级） |
| 角色走 `deepsonar-base` / `deepsonar-audit` / `deepsonar-kali-minimal` 且非上表 test/verify 动态路径 | 仍注入短索引提示，不注入整本手册或专项能力百科 |

专项 key 列表锁定在 `SPECIALTY_RUNTIME_IMAGE_POLICIES`（`apps/scheduler/src/domains/role-runtime-snapshot/runtime-image-boundary-policy.ts`）。

## 内置角色 → 默认镜像

来源：`DEFAULT_RUNTIME_IMAGE_BY_ROLE` + `database/schema.sql` 全局 RoleConfig 种子（`runtime_image_key` 为 `NULL` 时解析为 Base）。

| 角色 | kind | 默认 `image_key` | 适用证据（意图） | 备注 |
| --- | --- | --- | --- | --- |
| `test` | role | `deepsonar-kali-minimal` | 动态 PoC / 小服务 runtime_test | 全局 RoleConfig 显式绑 Kali |
| `audit` | role | `deepsonar-audit` | 读仓 + Agent 自选启发式；产出 Finding | 全局 RoleConfig 显式绑 Audit |
| `verify` | system | `deepsonar-base` | Finding 验证终态提案 | 需动态复现时由项目 RoleConfig 覆盖为 Kali/专项 |
| `explore` / `analyze` / `review` / `code` | role | `deepsonar-base` | 事实收集 / 分析 / 复核 / 改代码 | RoleConfig `NULL` → Base |
| `hub_reason` | hub | `deepsonar-base` | 画布决策与派发 | 通常不需要专项工具链 |
| `report` | system | `deepsonar-base` | 任务总报告 | 通常不需要专项工具链 |

角色镜像来源只由平台决定（#674/#691）：Job 缺省取全局 RoleConfig `runtime_image_key`，为空落到角色官方默认；项目不再持有镜像策略、角色→镜像映射或版本钉死。官方镜像默认可用（`deepsonar-base` 永不可停用，其它官方可排除）；第三方须平台 `visible_project_ids` 绑定后再由项目启用。`project_opt_in` 仅作元数据（如启动 warmup 跳过重镜像），不作为 Hub/角色选图硬门。

## 官方镜像能力表

| `image_key` | 默认适用角色 | 工具摘要（预装） | 明确不包含 | 缺能力纪律 | Scheduler 边界 |
| --- | --- | --- | --- | --- | --- |
| `deepsonar-base` | explore / analyze / review / code / hub / verify / report | Node 22 + 受治理通用 CLI 能力 id（`text.search.rg` / `json.query.jq` / `source.control.git` / `file.inspect.file` / `evidence.hash.sha256sum` / `execution.timeout` / `archive.extract` 等，见 #611） | JDK/Maven/Go/Rust 完整矩阵、Kali metapackage、专项浏览器/DB/设备协议；`fd`/`yq`/`diff`/`patch` phase 1 仅目录登记 | 缺命令 → 说明限制 / `capability_unavailable`；动态 verify 不得用静态叙述冒充 runtime | 无专项块（verify+非 base 才有 Runtime test 块） |
| `deepsonar-audit` | audit | Base 受治理 CLI 能力 + binutils 等审计辅助；**不**预装 Semgrep/gitleaks/shellcheck 决策扫描器 | SAST/密钥扫描器、Chrome/ClickHouse/设备协议全家桶；`fd`/`yq`/`diff`/`patch` 未钉死 | 同左；Finding 仍须可复查证据；CLI 输出不得直接升格 Finding | 无专项块 |
| `deepsonar-kali-minimal` | test（默认） | Temurin 8/11/17 + Maven 3.9.16、Python 3.10–3.14+uv、Go、Rust；无预置 `.m2` | Kali metapackage/GUI、DinD、完整 DB/Compose | Runtime test 纪律；缺工具 → `inconclusive`/`needs_human` | Runtime test（test / 动态 verify） |
| `deepsonar-chrome-test` | 项目覆盖 test/verify/… | 钉死 Chromium + CDP（playwright-core connectOverCDP） | 第二套 Chromium、完整 Playwright browsers、Selenium Grid、桌面 GUI | CDP/浏览器不可用 → `needs_human`/`inconclusive`；禁止源码叙述冒充 DOM | **任意角色**注入 Chrome CDP |
| `deepsonar-chrome-audit` | 项目覆盖 audit/… | git + Clang/LLVM + binutils；Agent 自选检查 | 固定扫描脚本/规则包、Chromium 浏览器本体、决策扫描器 | 缺工具 → `needs_human`/`inconclusive`；禁止把静态 C++ 当浏览器结果 | **任意角色**注入 Chrome/C++ audit |
| `deepsonar-chrome-fuzz` | 项目覆盖 test/… | 钉死 V8 `d8` + libFuzzer/AFL++/sanitizer | toy d8、第二套 V8、完整 Chrome 浏览器 | 缺 d8/构建失败 → `needs_human`/`inconclusive` | **任意角色**注入 Chrome/V8 fuzz |
| `deepsonar-clickhouse-test` | 项目覆盖 test/verify/… | 钉死官方 ClickHouse LTS（server/client/local） | apt/非官方包、DinD、toy SQL harness | 官方二进制不可用 → `needs_human`/`inconclusive` | **任意角色**注入 ClickHouse official |
| `deepsonar-clickhouse-audit` | 项目覆盖 audit/… | git + CMake/Ninja + Clang/LLVM + binutils | 固定扫描脚本、本镜像内 CH server、决策扫描器 | 缺工具 → `needs_human`/`inconclusive` | **任意角色**注入 ClickHouse/C++ audit |
| `deepsonar-clickhouse-fuzz` | 项目覆盖 test/… | 官方 clickhouse-local + Clang sanitizer + AFL++/libFuzzer | toy harness 冒充官方 binary | 缺官方 binary → `needs_human`/`inconclusive` | **任意角色**注入 ClickHouse fuzz |
| `deepsonar-openharmony-test` | 项目覆盖 test/… | 源码同步/构建 + 官方 `hdc` 设备协议 | DevEco/完整 SDK、把 gdb/strace 当设备协议 | `hdc list targets` 空 → `needs_human`/`inconclusive` | **任意角色**注入 OH hdc |
| `deepsonar-openharmony-audit` | 项目覆盖 audit/… | 主机 Clang/tidy/cppcheck/sparse + ASan/UBSan | 设备协议 hdc、密钥扫描器、DevEco | 缺主机工具 → `needs_human`/`inconclusive`；禁止把构建日志写成设备结果 | **任意角色**注入 OH host audit |
| `deepsonar-openharmony-fuzz` | 项目覆盖 test/… | 主机 libFuzzer/AFL++ + sanitizer | DevEco、toy harness | 缺工具链 → `needs_human`/`inconclusive` | **任意角色**注入 OH host fuzz |
| `deepsonar-mobile` | 项目覆盖 audit/test/… | Android JADX/apktool/…/droidasc/apkcheckpack/adb/Frida；iOS libimobiledevice；OH HAP/hdc；`.so` radare2/LIEF | MobSF/jadx-gui/Burp/IDA/Ghidra/DevEco/第三方 MCP/mitmproxy；禁止 droidasc `--gui` | 空 adb/hdc/idevice → `needs_human`/`inconclusive`；勿用 JADX/droidasc 叙述冒充设备/流量 | **任意角色**注入 Mobile protocols |

Harness 出处：`agent-harness/chrome-*-runtime.json`、`clickhouse-*-runtime.json`、`mobile-runtime.json`、`openharmony-test-runtime.json`、`kali-minimal-runtime.json`、`runtime-images.json`；Dockerfile 头注释、`tool-manifest.json` 与 `runtime-manuals/catalog.json` 为构建期契约。完整手册在镜像内固定为 `/opt/deepsonar/manuals/`，Worker 按 `index.json` 定位当前镜像的工具章节。

## Hub 目录与操作者 UI

- **Hub 必读**：`list_available_runtime_images`（见上）；按 `selection_hints` / `capabilities` 匹配，禁止猜 key。
- 市场页仍主要展示 `description` / `tools_json`；RoleConfig 选择器 hint 对已知 key 附「不包含」一句话（`apps/web/src/runtime-image-boundary.ts`，与 Hub 目录同 key）。
- 镜像详情页更重的结构化展示可 follow-up，不以 UI 为 #565 验收主路径。

## 工具说明书（#588）

每个官方运行镜像（含 base）必须在镜像内提供完整工具说明书，路径统一为 `/opt/deepsonar/manuals/`（`INDEX.md` + `tools/*.md`）。

- 仓库源：`agent-harness/runtime-manuals/catalog.json`；每个镜像的继承工具在目录中完整展开。
- 构建：`materialize-runtime-manuals.mjs` 按最终 `tool-manifest.json` 生成 `index.json`、`INDEX.md` 与逐工具章节；标签固定为 `/opt/deepsonar/manuals/index.json`。
- 验收门禁：`test-runtime-manuals.mjs` 校验 13 镜像、字段、覆盖、Dockerfile 与 fingerprint；`test-runtime-manuals-runtime.mjs` 在断网降权容器中重算摘要并核对实际文件。
- Worker 发现：`withRuntimeTestToolchainPolicy` 对任意已解析官方镜像注入 manuals 阅读要求；专项边界策略亦指向 `INDEX.md`。
- 说明书须覆盖 Agent 面向工具/包装入口（含继承工具），区分内部依赖；失败分类不得一律 `needs_human`。

## 校验

- `apps/scheduler/src/domains/role-runtime-snapshot/role-runtime-snapshot.characterization.test.ts` 锁定 policy 字符串、专项 key 集合与本文档关键锚点。
- 改默认角色镜像或专项边界时：同步改 `DEFAULT_RUNTIME_IMAGE_BY_ROLE` / schema 种子 / `SPECIALTY_RUNTIME_IMAGE_POLICIES` / 本文 / Web one-liner。
