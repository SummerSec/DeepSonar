# REA CLI 深度二进制解析能力（#718）

> **状态：进行中（PR2 已完成 amd64 实跑与行为门禁）**。镜像矩阵见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)；通用 CLI 包见 [`CLI_CAPABILITIES.md`](CLI_CAPABILITIES.md)；工具手册契约见 [`RUNTIME_TOOL_MANUALS.md`](RUNTIME_TOOL_MANUALS.md)。

## 目标

按需为 DeepSonar 增加 **CLI-only** 的深度原生二进制解析：通过钉死的 [REA](https://github.com/morluto/rea)（`rea-agents@6.4.0`）驱动 Ghidra 12.1.4，对 ELF / `.so` / PE 获取函数伪代码、汇编、调用关系、交叉引用与有界静态值流，并接入现有 Evidence 链。

## 架构约束

- **平台是控制面**：allowlist / 准入 / 镜像 digest；AI 运行时选型。不引入固定角色、MCP、常驻 REA 服务或第二执行通道。
- **项目 opt-in 镜像** `deepsonar-reverse`：从 `deepsonar-base` 派生；**不改变全局默认镜像**；**不把 Ghidra 塞进 `deepsonar-mobile`**。
- 硬控制沿用 Job 沙箱 CPU/内存/PIDs、网络策略、deadline、取消与 Reaper。薄 CLI launcher **不**提供不可绕过的累计调用计数器。

## 钉死基线

| 组件 | 版本 / 完整性 |
| --- | --- |
| rea-agents | `6.4.0`，gitHead `a56f7bb668ab23fec8d33f7af353ac7ed2fe1895`，npm integrity 构建期校验 |
| Ghidra | `12.1.4` PUBLIC zip，SHA-256 `ddac49f9…d4db` |
| JDK | 完整 64 位 Temurin 21（`JAVA_HOME=/opt/deepsonar/jdks/21`） |
| Node | ≥ `22.19.0`（继承 base，构建期校验） |

## 受治理能力

| 能力 ID | 工具 | 兼容镜像 | 说明 |
| --- | --- | --- | --- |
| `binary.rea.cli` | `rea` / `rea-agents` | `deepsonar-reverse` | analyze / search / function / decompile / instructions / xrefs / trace-native-values / inspect-analysis-view |

Hub 通过 Intent `cli_capability_ids` 提案；Scheduler `admitCliCapabilities` 校验后冻结。结果 schema 仍为 `deepsonar.cli-capability-result/v1`（`is_finding: false`）。缺失能力 / 非 `deepsonar-reverse` 镜像 → `capability_unavailable`。

## 受治理 Skill

- 路径：`skills/deepsonar-rea-cli/SKILL.md`
- 内容哈希：见 `agent-harness/reverse-runtime.json` → `skill.content_hash`（静态门禁校验）
- 用途：指导 Agent 在 `deepsonar-reverse` 内按 CLI/证据边界调用 REA；**不是** MCP 注册说明书

## amd64 实测（PR2）

验证方式：validation host 无 docker，在 scratch 目录安装与镜像相同的钉死工具链（Node 22.20 / Temurin 21 / Ghidra 12.1.4 / rea-agents@6.4.0），对公开样本 `agent-harness/fixtures/reverse-sample/sample.c` 实跑。完整数字见 [`agent-harness/reverse-amd64-measurements.json`](../agent-harness/reverse-amd64-measurements.json)。

| 指标 | 结果 |
| --- | --- |
| 冷启动 `analyze` | ≈ 12.8 s；峰值 RSS ≈ 3.3 GiB |
| 重复 `analyze`（`--snapshot`） | ≈ 1.6 s |
| `function` / `decompile` / `xrefs` / `search` / `instructions` | ≈ 12–13 s |
| 有界 `trace-native-values` | ≈ 18 s（不支持 `--snapshot`） |
| `inspect-analysis-view` | ≈ 1.3 s（需 inline Evidence + native facet） |
| 取消（SIGTERM） | ≈ 4.3 s 返回 `cancelled`；无残留 `java` |
| 组件解压体积（jdk+ghidra+rea） | ≈ 1285 MiB |
| 镜像压缩预算 | **暂定 2800 MiB**（待首次 OCI `docker save`） |
| Job 资源建议 | memory ≥ **4096 MiB**，CPU ≥ 2，timeout 600 s |
| arm64 | **pending** |

### 已知限制

- `--snapshot` 是精确查询缓存，不是持久 Ghidra 工程；`function`/`decompile` 等仍可能重新导入。
- `trace-native-values` / `inspect-analysis-view` 不接受 `--snapshot`。
- `inspect-analysis-view` 输入必须是 `{source:{kind:"inline"|"retained-evidence"}, view:{...}}`。
- 伪代码 / 静态值流 ≠ 原始源码 / 动态证明 / 已验证漏洞。
- 完整镜像内冷启动与 OCI 压缩体积仍待首次 reverse 镜像构建。

## 行为门禁（CI）

Scheduler 单元测试覆盖 Evidence 归一化路径：成功、非零退出、截断、部分 JSON、超时、取消、清理计划，以及缺失能力 / 未准入镜像拒绝。

```bash
pnpm ci:unit:cli-capability
node agent-harness/test-reverse-runtime.mjs
pnpm ci:images
```

## 仍待 follow-up

- `.github/workflows/reverse-runtime.yml` 与 `release.yml` reverse 发布 job（需 GitHub `workflow` scope）
- 首次发布 `deepsonar-reverse` digest 后回填 registry `versions` 并用 `docker save` 校准 `maxSizeMiB`
- arm64 native decompiler 对等实测
- 真实 Job 端到端：Skill 拉取 → CLI → Evidence → Fact/Artifact → 独立 Verify
- 项目显式启用前的准入放行（全局默认仍不变）
