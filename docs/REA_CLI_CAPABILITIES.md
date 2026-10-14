# REA CLI 深度二进制解析能力（#718）

> **状态：v0.5.5 已发布 `deepsonar-reverse`（2026-10-14）**：canonical digest `sha256:45b538274f513933135bd895d7350d51c7c0a557e5784a77e74b4be9b82820b8` 已回写 bundled registry，GHCR / Docker Hub / ACR 三通道 inspect 通过；Release 附件含双架构 native + published-manifest Job evidence。官方目录同步将该 digest 记为 `static-registry` trusted 版本；**全局默认不变**，仍须项目 opt-in 启用。镜像矩阵见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)；通用 CLI 包见 [`CLI_CAPABILITIES.md`](CLI_CAPABILITIES.md)；工具手册契约见 [`RUNTIME_TOOL_MANUALS.md`](RUNTIME_TOOL_MANUALS.md)。

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
| Node | `^22.19.0 || ^24.11.0 || >=26.0.0`（继承 base，严格匹配发布包 engines） |

## 受治理能力

| 能力 ID | 工具 | 兼容镜像 | 说明 |
| --- | --- | --- | --- |
| `binary.rea.cli` | `rea` / `rea-agents` | `deepsonar-reverse` | analyze / search / function / decompile / instructions / xrefs / trace-native-values / inspect-analysis-view |

Hub 通过 Intent `cli_capability_ids` 提案；Scheduler `admitCliCapabilities` 校验后冻结。结果 schema 仍为 `deepsonar.cli-capability-result/v1`（`is_finding: false`）。缺失能力 / 非 `deepsonar-reverse` 镜像 → `capability_unavailable`。

## 受治理 Skill

- 路径：`skills/deepsonar-rea-cli/SKILL.md`
- 内容哈希：见 `agent-harness/reverse-runtime.json` → `skill.content_hash`（静态门禁校验）
- 用途：指导 Agent 在 `deepsonar-reverse` 内按 CLI/证据边界调用 REA；**不是** MCP 注册说明书

## 历史 amd64 主机实测（PR2）

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
- 上表只记录历史主机实测；当前 OCI 的实测来自下述原生 CI artifact，不能把历史结果当作当前镜像通过。

## 项目启用（PR3）

- `database/schema.sql` 官方目录种子包含 `deepsonar-reverse`：`official=true`、`project_opt_in=true`、`enabled=true`，描述与 `deploy/runtime-image-registry.json` 一致；`db:rebuild` 回填同一条种子。`DEFAULT_RUNTIME_IMAGE_BY_ROLE` 不变（Test→kali-minimal、Audit→audit、其余→base），reverse 永不成为角色默认。
- 按 #691 当前模型，`project_opt_in` 是元数据：启动 warmup 跳过（`isStartupRequiredRuntimeImage=false`），全局作用域 real 预检返回 `RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED`，必须在具体项目内评估。
- 项目作用域内官方镜像缺行即默认可用；项目可经 `PUT /projects/:id/runtime-images/:imageId` 显式排除，排除后预检返回 `RUNTIME_IMAGE_PROJECT_NOT_ENABLED`，Job 创建 `resolveRuntimeImageForJob` 同样拒绝。
- 真正可执行仍取决于平台目录中存在 trusted digest。v0.5.5 已把 `deepsonar-reverse@0.5.5`（canonical `sha256:45b53827…`）回写 bundled registry；`applyOfficialRuntimeCatalog` 同步后写入 `trust_status=trusted`、`scan_summary.source=static-registry`（官方信任根是 Release catalog digest，不是第三方 Trivy 门禁）。无 trusted 版本时预检仍会如实报告镜像不可用。

## 受治理 Job 路径（PR3）

无 docker 时用真实契约 + 夹具覆盖整条路径（`apps/scheduler/src/domains/cli-capability/rea-cli-job-e2e.test.ts`）：

1. **Skill 发现/拉取**：按受信 Skill 源同步方式扫描 `skills/`，`list_available_skills` / `search_skills` 返回 `deepsonar-rea-cli` 的 selector 与 content hash；`pull_skill` 只在 hash 匹配时返回文件，拉到的 `SKILL.md` 字节哈希必须等于 `reverse-runtime.json` 的 `skill.content_hash`；过期 hash、宽 selector、未知模块一律拒绝。
2. **能力发现与准入**：`search_capabilities` / `describe_capability` 能找到 `binary.rea.cli`；`admitCliCapabilities` 只在 `deepsonar-reverse` 冻结，manifest 的 `tool_version` / timeout 与 `reverse-runtime.json` 一致；mobile/base 等镜像返回 `incompatible_image`，安装请求返回 `install_forbidden`。
3. **Evidence 归一化**：成功 / 非零 / 截断 / 部分 JSON / 超时 / 取消逐一贯穿到 Fact，不完整结果在描述与 Artifact 扩展中保持 `inconclusive`；清理前保留 `evidence_ref`，删除 Ghidra 临时工程。
4. **Fact/Artifact 提交**：`buildReaCliFactProposal` 把一次观察映射为 `emit_fact` 提案：不带 `verification`，claim/evidence 一律 `unknown`，原始 stdout 不进 Fact（只引用留存的 evidence），元数据进 Artifact 扩展 `binary.rea-cli`（能力 id、工具版本、exit、截断、样本 SHA-256、镜像 digest、argv）。
5. **Verify 独立**：原始 `CliCapabilityResult` 不能当作 `emit_fact` / `emit_finding` 载荷；REA 观察 Fact 不满足结构化验证 Fact，Fact-first confirm 门返回 `insufficient`；`exit_code=0` 本身也不是 runtime proof。

项目启用门禁见 `apps/scheduler/src/reverse-runtime-project-opt-in.test.ts`（种子、回填、warmup、#691 排除、预检作用域、Hub 目录投影）。

## 行为门禁（CI）

Scheduler 单元测试覆盖 Evidence 归一化路径：成功、非零退出、截断、部分 JSON、超时、取消、清理计划，以及缺失能力 / 未准入镜像拒绝；PR3 增加上面的 Job 路径与项目启用门禁（分别接入 `ci:unit:capability-pack` / `ci:unit:cli-capability` 与 `ci:unit:runtime-images`）。

```bash
pnpm ci:unit:cli-capability
pnpm ci:unit:runtime-images
node agent-harness/test-reverse-runtime.mjs
pnpm ci:images
```

## 运行期归档绑定

`deepsonar.rea-observation/v1` 将原始 stdout、脱敏 stderr、exit/截断/超时/取消状态、实际限制、样本摘要、工具版本、Job/Attempt 和冻结镜像写入普通工作区文件。Agent 经已有 `publish_shared_asset` 将其存为同项目不可变版本，再以 `artifact.extensions["binary.rea-cli"].evidence_key` 调用 `emit_fact`。Host 验证发布归属、活动 Attempt、CAS 摘要、冻结能力/镜像/预算后生成 unknown-only Fact/Artifact；完整可执行示例见受治理 Skill。

这条链认证归档来源和完整性，不认证 Agent 所报告的 argv/工具输出为可信执行凭证；不得将其视为 runtime proof。缺失/跨 Job/旧 Attempt/内容损坏/不匹配快照/越权 verification 都拒绝。取消/超时前应主动归档前缀；token 撤销后不能补传，未完成前缀持续 inconclusive。

## 原生 OCI 与真实 Job 门禁

`.github/workflows/reverse-runtime.yml` 在 `ubuntu-24.04` / `ubuntu-24.04-arm` 分别从当前 checkout 构建 base 与 reverse，PR 不获取 registry 写凭据、不发布标签、不通过 QEMU 代替原生验证。release 的 `reverse-image-builds` 使用本次 `base-image` 输出的不可变 digest；缓存命中也必须执行相同真实门禁。

- 官方 Ghidra 12.1.4 PUBLIC zip 没有 Linux arm64 decompiler。arm64 builder 从同一个 SHA-256 校验过的 zip 的 bundled C++ 源码运行 `ghidra_opt` 原生构建；不运行 Gradle 下载、不回退到其它版本。最终镜像不包含编译对象和构建工具；ELF64 machine header 与宿主架构都必须匹配。
- REA 的下载 tarball 本身校验固定 SHA-512 integrity，安装后的 lock entry 再核对；仅比较 `npm view` 元数据不算完整性验证。Node engines 与完整 JDK 21 在构建和运行期校验。
- `agent-harness/reverse-native-smoke.mjs` 在真实 OCI 内运行公开源代码编译的 ELF / `.so` / PE（PE 只静态解析、不执行），覆盖首期八种 CLI 命令、函数 dossier 与有界 view/trace，执行环境检查与离线手册校验。
- 真实压缩体积来自 `docker save | gzip`，不是上游包大小。记录样本/编译器/工具/源码 revision/OCI 身份、冷启动、重复与不同查询、cgroup 峰值、SIGTERM 响应和残留进程。生产镜像默认 `GHIDRA_HEADLESS_MAXMEM=1536m`，与 4096 MiB、2 CPU 的测试口径一致；2800 MiB 是拒绝超限的预算，不是声称实测结果。
- `pnpm ci:integration:rea-job` 使用独立测试数据库、仓库已钉死 OpenSandbox server/execd/egress、真实 Scheduler dispatcher / executor / Claude CLI；本地确定性模型只发出测试指令，REA/Ghidra 是真实执行。经 Skill 拉取、Evidence 归档、Control API `emit_fact` 与独立 Verify 校验实际闭环。测试环境不需要真实 Provider 密钥。
- PR 本地镜像 ID 测试只证明该 rootfs 的行为；release Job 使用实际 `repository@sha256` 引用。隔离测试快照不代表生产 registry/admission 扫描批准，也不改变任何项目或全局默认。
- 每架构保留 `reverse-native-evidence-<arch>` 和 `reverse-job-evidence-<arch>`，失败时也上传已取得的材料；未执行、非零、缺失或部分结果不能标为成功。具体通过结论须指向对应 commit 的成功 Actions run 与 artifact。

## 发布与启用边界

`reverse-images` 只有在双架构真实门禁成功后，才从这两个已测试 child manifest 组装 canonical index，写 `reverse.json` 并走既有 GHCR / 已配置 Docker Hub / 已配置 ACR 镜像发布和 inspect 证据链。已有版本标签只能复用相同的 index digest，不能因为子 payload 一致而移动到另一个 wrapper digest；无法 inspect、冲突或已配置通道失败一律阻止生成完整发布清单。

最终 Release job 包含 reverse 依赖、离线手册和 catalog/platform payload 一致性检查（7 个专项产品、14 个原生 child），生成器继续强制要求 `reverse.json`。不得以空 descriptor、手写 digest、复制其它产品记录或删必需产品绕过首次发布。

v0.5.5 Release（run [38506851988](https://github.com/SummerSec/DeepSonar/actions/runs/38506851988)、附件 `deepsonar-reverse-evidence-0.5.5.tar.gz`）已满足关闭条件：双架构 native + `identity_kind=published-manifest` 真实 Job（success/verify/failure/cancel/timeout；独立 Verify `final_outcome=rework`）、canonical index digest 与三通道 inspect、registry `versions` 回写，以及官方 catalog → trusted 准入边界（见 `reverse-runtime-project-opt-in.test.ts`）。项目须显式启用；**不**自动改全局默认。
