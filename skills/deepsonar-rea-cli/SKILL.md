---
name: deepsonar-rea-cli
description: 在 DeepSonar deepsonar-reverse 镜像内通过受治理 REA CLI（非 MCP）对 ELF/.so/PE 做有界深度静态分析，并按证据链归档结果。
---

# DeepSonar REA CLI（深度二进制解析）

仅在冻结镜像为 `deepsonar-reverse` 时使用。平台是控制面：能力由目录/准入与镜像 digest 约束；不要安装额外工具、不要注册 MCP、不要启动常驻 REA 服务。

## 钉死基线

- `rea-agents@6.4.0`（gitHead `a56f7bb668ab23fec8d33f7af353ac7ed2fe1895`）
- Ghidra `12.1.4`，`GHIDRA_INSTALL_DIR=/opt/deepsonar/ghidra`
- 完整 64 位 JDK 21：`JAVA_HOME=/opt/deepsonar/jdks/21`
- Node ≥ 22.19（继承 `deepsonar-base`，构建期校验）

## 发现与手册

1. 先读 `/opt/deepsonar/manuals/index.json`，再读 REA / Ghidra / Java 章节。
2. 通过平台 `list_capabilities` / `describe_capability` 确认 `binary.rea.cli` 已准入并冻结进 Job。
3. 调用前执行 `reverse-env.sh --check` 或 `rea doctor --provider ghidra --json`。

## 推荐 CLI（provider=ghidra）

对绝对路径样本使用 `--json`，优先复用一次 `function` dossier，限制追踪深度与返回体积：

```bash
rea analyze /workspace/sample --provider ghidra --json
rea search /workspace/sample "pattern" --provider ghidra --json
rea function /workspace/sample main --provider ghidra --json
rea decompile /workspace/sample 0x1000 --provider ghidra --json
rea instructions /workspace/sample 0x1000 --provider ghidra --json
rea xrefs /workspace/sample 0x1000 --provider ghidra --json
rea trace-native-values /workspace/sample "pattern" --provider ghidra --json
rea inspect-analysis-view /workspace/view.json
```

可用 `--snapshot /workspace/analysis/sample.json` 复用精确查询缓存；快照不是持久 Ghidra 工程数据库。

## 证据与语义边界

在沙箱清理前保留：原始 JSON、脱敏 stderr、退出码、截断/部分完成标记、分析限制、样本 SHA-256、Job/Attempt、工具版本、镜像 digest、脱敏 argv。失败/取消/超时也归档已取得片段；未完成结果不得解释为成功。

伪代码与静态值流 **不等于** 原始源码、动态证明或已验证漏洞。CLI 输出只作 Evidence/Fact 输入（`is_finding: false`），Finding 须走独立 Verify。



## amd64 实测摘要（#718 PR2）

主机 scratch 工具链（非已发布 OCI digest；本机无 docker）对公开可复现样本 `agent-harness/fixtures/reverse-sample/sample.c` 的实测见 `agent-harness/reverse-amd64-measurements.json`：

- 冷启动 `analyze` ≈ 13s；带 `--snapshot` 的重复 `analyze` ≈ 1.6s
- `function` / `decompile` / `instructions` / `xrefs` / `search` ≈ 12–13s（仍可能重新导入）
- 有界 `trace-native-values` ≈ 18s（**不**支持 `--snapshot`）
- `inspect-analysis-view` 需 `{source:{kind:"inline",evidence},view:{kind:"native",facet,...}}`，≈ 1.3s
- 峰值 java+node RSS ≈ 3.5 GiB（`GHIDRA_HEADLESS_MAXMEM=1536m`）→ Job 建议内存 **≥ 4096 MiB**
- SIGTERM 取消 ≈ 4.3s 返回 `cancelled`，无残留 `java`
- 镜像压缩体积预算暂定 **2800 MiB**（待首次 `docker save` 实测）；**arm64 pending**

## 失败纪律

- 镜像未准入 / 能力未冻结 / 冻结快照不可解析 → 结构化 `capability_unavailable`，禁止临时 `npm i` / 扩大网络。
- 缺 native decompiler 或 `rea doctor` 失败 → 按角色证据边界报告，不得用 binutils/radare2 叙述冒充 REA/Ghidra 深度结果。
- 硬控制沿用 Job 沙箱 CPU/内存/PIDs、网络策略、deadline、取消与 Reaper；薄 launcher 不提供不可绕过的累计调用计数器。
