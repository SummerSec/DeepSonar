# Agent 运行时与能力镜像架构（理想模型）

> **状态：设计原则 / 目标架构（非 as-built）**  
> 本文刻意**不**绑定当前 Dockerfile 或 catalog 的落地方式，只描述在 DeepSonar 四层真相与供应链纪律下，**不考虑短期成本时的最佳形态**。  
> 实现迁移、与现状的差距对照见文末；冲突时以 `DESIGN.md`、代码与 OpenAPI 为准。  
> 索引：[`README.md`](README.md)。

---

## 1. 一句话

**CLI（Agent 平面）与领域工具链（能力平面）是两条供应链；只在构建/发布期合成为「一个不可变产品镜像」；Job 永远只消费该产品镜像的 digest。「动态」属于发布系统，不属于沙箱运行时。**

---

## 2. 约束来源（为何必须这样）

DeepSonar 的执行纪律要求：

| 约束 | 对镜像的含义 |
|------|----------------|
| 沙箱 = 执行真相 | 一次 Job = **一个** rootfs digest，可复现、可扫描、可对账 |
| Scheduler = 唯一副作用执行者 | 只有 Scheduler 解析并冻结镜像；Agent/Hub/任务正文不能指定镜像引用 |
| Agent 只提案 | 沙箱内无「再拉一层 CLI / 再拼工具」的权限 |
| Job 快照冻结 | `agent_cli`、adapter 版本、镜像 digest、工具清单哈希在创建时钉死 |
| 官方市场 + 准入 | 可调度对象必须有完整 SBOM/扫描/签名故事 |

因此：

- **允许**：构建图上的多层 `FROM` / `COPY --from`、矩阵 bake、依赖触发重建。  
- **禁止**：Job 启动时 merge 两个 digest、CLI volume 热挂、sidecar 充当半个 Agent 环境（除非改成完全不同的远程 Agent 协议产品）。

---

## 3. 四层模型

```text
L0  Foundation（系统底）
    OS、glibc、Node 等与「业务能力」无关的底。
    可按族分叉（Debian slim / Kali 底等），不装 Agent CLI，不装领域重型工具。

L1  Agent Plane（Agent 运行时）
    每个 CLI 一个钉死版本的制品，例如：
      agent-claude | agent-codex | agent-opencode | agent-pi | agent-dsh | …
    只解决：协议编解码、session、控制面（MCP/API）、HOME/路径约定。
    不装 Chromium、V8、OpenHarmony SDK、语言全家桶等。

L2  Capability Plane（领域能力）
    按审计/测试/模糊场景划分，例如：
      chrome-audit | chrome-test | chrome-fuzz
      openharmony-audit | openharmony-test | openharmony-fuzz
      generic-audit | kali-test | …
    只装该场景工具链与入口脚本、工具清单中的 capability 段。
    不装 claude/codex/opencode/pi 等 Agent CLI。

L3  Product Image（唯一可调度产物）
    L0 + 选定的 L1 + 选定的 L2 在构建期的合成结果。
    例：product-chrome-fuzz-claude@sha256:…
    Catalog、准入、项目策略、Job 冻结只针对 L3。
```

### 3.1 层职责

| 层 | 变什么时重建 | 不变什么 |
|----|----------------|----------|
| L0 | OS/CVE/基础运行时 | 不感知 CLI 与业务工具 |
| L1 | CLI 版本、adapter 契约、控制面依赖 | 不感知 Chromium/V8/OH |
| L2 | 领域工具、编译器、浏览器、模糊器 | 不感知具体 Agent 协议 |
| L3 | 任意 L1 或 L2 输入变化触发 bake | 对外表现为单一 digest |

### 3.2 为何 L1 按 CLI 拆分（理念最优）

- 协议演进互不耦合（stream-json / exec JSON / RPC 等）。  
- 许可、CVE、体积、Session 契约可单点治理。  
- Adapter 版本与 L1 制品一一对应，心智最小。  

「一个 runtime 塞齐所有 CLI」是运维折中，**不是**本理想模型的默认。

---

## 4. 组合发生在哪里

### 4.1 发布期（唯一推荐）

```text
matrix = L1_cli × L2_capability   （仅声明兼容的格子）

bake:
  for each (cli, capability) in matrix:
    product = compose(L0_family, L1[cli], L2[capability])
    scan / sign / publish product@digest
    registry[product_key] = digest + component provenance
```

合成方式（实现细节任选，理念等价）：

- `FROM L1` 再 `COPY --from=L2` 工具树；或  
- `FROM L2` 再 `COPY --from=L1` Agent 二进制与约定路径。  

能力层往往更大、与目标更相关时，**以 L2 为工作世界、打入 L1** 通常更清晰。

合成后必须生成：

- 合并后的 **tool-manifest**（agent 段 ∪ capability 段）  
- **components** 溯源：`agent_plane.digest` + `capability_plane.digest`  
- 单一 **L3 digest** 作为调度主键  

### 4.2 运行期（明确禁止）

| 模式 | 为何否决 |
|------|----------|
| 启动时 merge 两个镜像 rootfs | 无可准入的单一 digest，复现失败 |
| 共享 volume 挂 CLI | 并发污染、版本漂移、会话路径失控 |
| CLI sidecar + 工具主容器 | cwd/HOME/gateway/session 模型分裂 |
| Job 内再 `npm i -g` CLI | 破坏冻结与供应链 |

---

## 5. 调度与配置语义

人看到的二维选择，机器落成一维 digest：

```text
策略输入（项目镜像策略 / RoleConfig 等，仅 Scheduler 解析）
  capability_key : 领域能力（对应 L2 族）
  agent_cli      : Agent 平面标识（对应 L1）

Resolver
  if (capability_key, agent_cli) ∉ declared_matrix:
      fail closed   // 创建 Job 前拒绝
  product_key = matrix[capability_key][agent_cli]
  digest = pin 或 registry 晋升的最新可信版本

Job.agent_snapshot_json 冻结至少：
  - product image name@sha256
  - tools_manifest_sha256
  - agent_cli + adapter_id + adapter_version
  - components.agent_plane / components.capability_plane（推荐）
```

纪律：

- **Agent / 任务正文 / Hub 决策不得指定** product、L1、L2 或任意镜像引用。  
- **同一 Job 不切换** `agent_cli` 或镜像。  
- 兼容性以 **声明矩阵** 为准，禁止「镜像里碰巧有二进制就试跑」。

---

## 6. Catalog 与信任

| 对象 | 是否进入「可调度市场」 |
|------|------------------------|
| L3 Product | **是** — 扫描、签名、项目启用、Job 冻结 |
| L1 / L2 | 默认可为 **构建依赖**（`schedulable: false`）；若登记仅供审计溯源 |

推荐 L3 清单字段（概念）：

```json
{
  "image_key": "deepsonar-chrome-fuzz-claude",
  "digest": "sha256:…",
  "platforms": ["linux/amd64", "linux/arm64"],
  "components": {
    "agent_plane": {
      "cli": "claude-code",
      "version": "…",
      "source_digest": "sha256:…"
    },
    "capability_plane": {
      "key": "chrome-fuzz",
      "source_digest": "sha256:…"
    }
  },
  "tools_manifest_sha256": "…"
}
```

---

## 7. 与 Adapter / Session 的关系

| 平面 | 契约归属 |
|------|----------|
| L1 / agent_cli | Runtime Adapter、Session 发现与归档、Session 查看器解析、控制面能力 |
| L2 / capability | 工具存在性、断网冒烟、领域 entrypoint、大小预算 |
| L3 | 两者同时满足；缺一不可调度 |

升 CLI 版本：发新 L1 → bake 所有依赖 L3 → 同步 adapter pin 与 Session 契约测试。  
升能力工具链：发新 L2 → bake 相关 L3 → 领域冒烟；**不**误伤无关 CLI 的协议测试面。

新增 CLI（如 `dsh`）的清单：

1. L1 制品 + 钉版本/integrity  
2. Adapter + 能力声明  
3. Session 归档适配 + Web 查看器（若需）  
4. 矩阵中声明与哪些 L2 组合  
5. bake 并晋升对应 L3  

---

## 8. 发布图（理想）

```text
                    ┌── L1-claude ──┐
L0-debian ─────────┼── L1-codex  ───┼──► bake ──► L3 products ──► registry / admission
                    ├── L1-opencode ┤              (matrix cells)
                    └── L1-pi     ──┘
L0-kali ──────────► L2-kali-test ──┘
L0-debian ────────► L2-chrome-fuzz ─┘
                  ► L2-oh-audit ────┘
```

- CLI  bump：只重建该 L1 与依赖它的 L3。  
- 能力 bump：只重建该 L2 与依赖它的 L3。  
- 指纹/缓存以 **层输入 digest** 为键，避免「改注释却全量重编」或「改 CLI 却漏编专项」。

---

## 9. 非目标

1. Job 运行时多镜像 rootfs 合成或动态「融入」。  
2. 单一浮动 `latest` 超级镜像承载全部 CLI 与全部能力。  
3. Agent 或任务内容选择镜像 digest/tag。  
4. 用 sidecar 替代单沙箱会话模型（除非单独立项「远程 Agent 平面」产品）。  
5. 将 L1/L2 未扫描中间层直接暴露给项目作为可调度环境（默认可调度的只有 L3）。

---

## 10. 设计取舍摘要

| 问题 | 理想答案 |
|------|----------|
| CLI 是否单独成镜像？ | **是**，且 **按 CLI 拆分**（L1） |
| 能力是否单独成镜像？ | **是**（L2），不含 CLI |
| 如何「融入」Chrome/OH audit·test·fuzz？ | **发布期 bake 成 L3**，不是运行时挂载 |
| 调度选什么？ | **只选 L3 digest**（可由 capability + agent_cli 解析） |
| 动态性在哪？ | **CI/Release 依赖图与矩阵** |
| 与现网折中的关系？ | 现状「base 塞满 CLI + 专项 FROM base」是工程捷径；本文件描述的是目标理念 |

---

## 11. 与现状的差距（仅作对照，非规范）

当前实现常见形态是：通用 base 预装多个 CLI，专项镜像 `FROM` 该 base 再叠工具。这满足「专项里能跑 Agent」，但：

- L1/L2 边界模糊；  
- 升 CLI 易连带重编重型能力镜像；  
- 兼容矩阵偏「全开」而非显式格子。  

迁移若发生，应保持 **Job 仍只冻结单一 digest**，先抽 L1/L2 构建图，再逐步用矩阵 L3 替换「胖 base 继承」，而不是引入运行时 compose。

---

## 12. 相关文档

| 文档 | 关系 |
|------|------|
| [`DESIGN.md`](../DESIGN.md) | 产品 as-built；镜像与 RoleConfig 冻结纪律 |
| [`AGENT_CLI_RUNTIME_ADAPTERS.md`](AGENT_CLI_RUNTIME_ADAPTERS.md) | CLI 适配器契约与接入清单（as-built） |
| [`RUNTIME_IMAGE_REGISTRY_CONTRACT.md`](RUNTIME_IMAGE_REGISTRY_CONTRACT.md) | 官方 catalog 与通道（as-built） |
| [`RELEASE_RUNTIME_IMAGES.md`](RELEASE_RUNTIME_IMAGES.md) | 现行 release 流程（as-built） |
| [`RUNTIME_TEST_TOOLCHAINS.md`](RUNTIME_TEST_TOOLCHAINS.md) | 能力侧工具链边界（as-built） |

---

## 13. 修订

| 日期 | 说明 |
|------|------|
| 2026-08-13 | 初稿：理想四层模型、发布期矩阵合成、禁止运行时 compose |
