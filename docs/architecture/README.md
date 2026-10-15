# DeepSonar 系统架构设计

> 状态：**起草中（#741 PR 2）**。编号规则、阅读路径与维护流程已生效；`01-system-specification.md` 与 `traceability.md` 已落地首批三条关键链路。其余 02–12 视图与 ADR 按 [#741](https://github.com/SummerSec/DeepSonar/issues/741) 后续 PR 补齐；补齐前的事实仍以 [`DESIGN.md`](../../DESIGN.md)、[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)、代码、`database/schema.sql` 与 OpenAPI 为准。
> 同步日期：2026-10-15

本目录回答三件事：系统**必须做到什么**（系统规格）、**边界在哪里**（上下文、约束与信任边界）、**为什么这样建**（架构视图与 ADR）。它是架构治理基线：后续需求与结构性变更按「需求 ID + 追溯矩阵 + ADR」评审。

- **读者**：内部开发者与 AI 编码 Agent。不面向客户或非技术评审，因此不写营销化描述，强调可检索、可追溯、可机检。
- **非目标**：本目录不改变代码、schema、OpenAPI 与运行时行为，不新增能力；也不改变 [`DESIGN.md`](../../DESIGN.md) 作为 as-built 摘要的定位。
- **方法**：系统规格参考 ISO/IEC/IEEE 29148；架构视图参考 arc42 + C4 分层；关注点分离参考 ISO/IEC/IEEE 42010；决策记录用 ADR（见 [`adr/README.md`](adr/README.md)）。

---

## 1. 目录索引

「状态」列的取值见 §3。尚未创建的文件不加链接，落地时在同一 PR 中把对应行改为链接并更新状态。

| 文件 | 主题 | 视图 / 方法 | 状态 |
|------|------|-------------|------|
| [`README.md`](README.md) | 目录索引、阅读路径、文档状态、编号规则、维护流程 | — | **起草中**（PR 2） |
| [`adr/README.md`](adr/README.md) | ADR 模板（背景 / 决策 / 状态 / 后果 / 替代方案）与编号规则 | ADR | **骨架**（PR 1） |
| [`01-system-specification.md`](01-system-specification.md) | 系统规格（SRS）：功能需求 / 非功能需求 / 外部接口 / 约束，全部编号 | ISO/IEC/IEEE 29148 | **起草中**（PR 2，首批三链路） |
| [`traceability.md`](traceability.md) | 追溯矩阵：需求 ID → 架构视图 / ADR → 代码入口 → 测试或 CI gate | — | **起草中**（PR 2） |
| `02-context-and-scope.md` | 系统上下文：外部参与者、系统边界、范围内 / 范围外 | C4 L1 | 计划中（PR 3） |
| `03-constraints-and-principles.md` | 架构约束与原则：四层真相、内核拥有的边界、不向后兼容、覆盖优先级 | arc42 §2 / §4 | 计划中（PR 3） |
| `10-security-and-trust-boundaries.md` | 安全与信任边界：威胁模型、凭据、网络、沙箱、capability token | arc42 §8 | 计划中（PR 3） |
| `05-building-blocks.md` | 构件视图：apps / packages、Scheduler bounded contexts、依赖方向 | C4 L2 / L3 | 计划中（PR 4） |
| `06-runtime-view.md` | 运行时视图：任务 → Hub → Job / Attempt → Control API → Finding → Verify → Report | arc42 §6 | 计划中（PR 4） |
| `07-deployment-view.md` | 部署视图：Compose 拓扑、OpenSandbox、镜像准入、多副本与共享存储 | arc42 §7 | 计划中（PR 4） |
| `08-data-architecture.md` | 数据架构：schema 基线纪律、真相分层、events / evidence / stream-bus | arc42 §8 | 计划中（PR 4） |
| `04-quality-attributes.md` | 质量属性场景：NFR 落成「刺激-响应-度量」场景，并映射到 CI gate | arc42 §10 | 计划中（PR 5） |
| `09-interface-specs.md` | 接口规范：Management / Control API、错误码、RepairFeedback、幂等键 | — | 计划中（PR 5） |
| `11-engineering-specs.md` | 工程规范：命名、状态字段、配置、日志脱敏、测试分层、文档与发布保鲜 | — | 计划中（PR 5） |
| `12-risks-and-tech-debt.md` | 风险与技术债：待删除实现债务、暂缓设计 | arc42 §11 | 计划中（PR 5） |
| `adr/0001-*.md` … `adr/0006-*.md` | 首批 6 条 ADR 回填（只记录已定案结论） | ADR | 计划中（PR 5） |

---

## 2. 阅读路径

| 读者 / 场景 | 建议顺序 |
|-------------|----------|
| **新成员 / 协作者** | [`DESIGN.md`](../../DESIGN.md)（as-built 摘要）→ 02 系统上下文 → 03 约束与原则 → 05 构件视图 → 06 运行时视图 → 按需查阅专题文档（[`docs/README.md`](../README.md)） |
| **AI 编码 Agent（改动前）** | [`AGENTS.md`](../../AGENTS.md)「设计事实入口」→ 01 系统规格中与改动相关的需求 ID → `traceability.md` 找到代码入口与测试 → 03 / 10 确认不跨越内核与信任边界 → 代码、`database/schema.sql`、OpenAPI |
| **架构评审 / 结构性变更** | 01 系统规格（受影响需求）→ `traceability.md` → 相关视图（05–08）→ [`adr/`](adr/README.md) 既有决策 → 起草新 ADR 或修订需求 |
| **安全评审** | 10 安全与信任边界 → 02 系统上下文 → 09 接口规范 → 07 部署视图 |

在对应文件落地前，上述位置以 [`DESIGN.md`](../../DESIGN.md) 与 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) 为准。

---

## 3. 文档状态

每个文件文首必须有一个引用块，至少包含两行：

```markdown
> 状态：**<状态>**（<关联 issue / PR>）。<一句话说明适用范围与例外>
> 同步日期：YYYY-MM-DD
```

「同步日期」是最近一次与代码、`database/schema.sql`、OpenAPI 核对一致的日期（Asia/Shanghai），不是最后编辑日期。只改措辞、未重新核对事实时不更新日期。

| 状态 | 含义 |
|------|------|
| **骨架** | 结构与规则已定，正文待后续 PR 填充 |
| **计划中** | 已在本索引登记，文件尚未创建 |
| **起草中** | 文件已创建，部分章节尚未与代码核对；未核对章节须在章节标题后注明 |
| **as-built** | 全文已与代码、schema、OpenAPI 核对一致；冲突以代码为准并回写本目录 |
| **暂缓** | 主题已识别但刻意不推进，须写明原因与关联 issue |

---

## 4. 编号规则

### 4.1 文件编号

- 视图文件用两位数字前缀 `NN-kebab-case.md`，编号即推荐的整体阅读顺序；新增视图追加到末尾，**不重排、不复用**已发布编号。
- 不属于视图序列的横切文件（`README.md`、`traceability.md`）不加编号。
- ADR 放在 `adr/`，编号规则见 [`adr/README.md`](adr/README.md)。

### 4.2 需求 ID

需求 ID 是稳定标识，供评审、追溯矩阵与 Agent 直接引用（例如 `rg FR-JOB-003` 即可定位）。

| 前缀 | 类别 | 域 / 属性 |
|------|------|-----------|
| `FR-<域>-NNN` | 功能需求 | `TASK`、`HUB`、`JOB`、`CTRL`（Control API）、`CAP`（能力 / Pack / Skill）、`FIND`、`VERIFY`、`RSCH`、`RPT`、`IMG`、`CRED`、`WEB` |
| `NFR-<属性>-NNN` | 非功能需求 | `SEC`、`REL`（可恢复 / 幂等）、`PERF`、`OBS`、`EVO`（可演进）、`OPS` |
| `IR-NNN` | 外部接口需求 | Model Provider、OpenSandbox、镜像 registry、GitHub Release、Web / API Token 等 |
| `CON-NNN` | 设计约束 | 不向后兼容、单一 schema 基线、Scheduler 唯一副作用执行者等 |

**跨切关注点归属（不一律新设前缀；需要时再升格）**：

| 关注点 | 本期归属 | 说明 |
|--------|----------|------|
| Canvas 过程真相（节点 / 边 / 投影 / delta / 广播 / human） | `FR-TASK` + 运行时视图 | 任务即画布；细则链到 canvas 域代码与计划中的 `06` |
| Fact 证据信任态（与 Finding Verify 分责，#387） | `FR-FIND` / `FR-VERIFY` | Fact 门禁写在 FIND；独立复核写在 VERIFY；待 ADR-0004 |
| Artifact 版本化写入 | `FR-JOB` / `FR-FIND` / `FR-RPT` | 内部写入真相 vs 报告投影；待 ADR-0007 |
| Device（device-broker / Attempt 租约） | `FR-JOB`（租约随 Attempt） | 专章可后续升 `FR-DEV`；详见 [`DEVICE_ACCESS.md`](../DEVICE_ACCESS.md) |
| 共享资产 BlobStore / `.deepsonarpack` 导入导出 | `FR-CAP` 或 `NFR-OPS`（后续专条） | 本期三链路未展开；权限与脱敏契约仍以代码为准 |

- `NNN` 为三位、从 `001` 起在同一前缀内递增；**ID 一经发布不得复用、不得改作他义**。
- 需求被废弃时保留条目并标注「已废弃」及原因 / 取代者，不直接删除，避免旧引用悬空；废弃 ID 同时登记进 `docs-freshness` 的 `DEPRECATED_REQUIREMENT_IDS`。
- **定义格式**：`01-system-specification.md` 中以独立成行的 `### FR-JOB-001` 作为唯一定义部位（机检只认此格式）；正文与 `traceability.md` 中的出现是引用。
- **条目结构**：`规范要求` → `决策来源` → `实现状态` → `代码入口` → `验证证据`。状态取值：`as-built` / `进行中` / `暂缓` / `已废弃`。
- **冲突**：先判定文档漂移 / 实现违约 / 尚未决策；实现违约登记缺陷，不改规范合法化错误。
- **度量值纪律**：非功能指标只写代码或配置中真实存在的默认值与上限，并注明出处；没有实现依据的写「未定义」或「尚未验证」，不凭空编造目标值。配置默认值不能替代质量达标证据。

### 4.3 单一权威位置

每类架构事实（原则、边界、状态机、接口约束、工程规范）在本目录内只有一个权威正文位置，其它位置只写链接。现有专题文档（`RUNTIME_*`、`AGENT_*`、`DEVICE_ACCESS.md` 等）本期不移动，由对应视图与需求的「来源 / 验收」列链接引用。

---

## 5. 维护流程

1. **结构性变更**（内核边界、信任边界、状态机、接口契约、数据真相分层、部署拓扑）必须在同一 PR 中：更新受影响的需求 ID 与 `traceability.md`；必要时新增或取代 ADR；更新相关视图文首的状态与同步日期。
2. **冲突判定后再改**：as-built 描述漂移时回写本目录（冲突以代码、`database/schema.sql`、OpenAPI 为准）；已采纳规范被代码违反时登记实现违约，不改规范迁就缺陷；与 [`DESIGN.md`](../../DESIGN.md) 的摘要冲突时同步两边。
3. **不重复正文**：`DESIGN.md` 保持 as-built 摘要，细节链接到本目录对应视图；`docs/ARCHITECTURE.md` 中已迁入本目录的主题以本目录为准，原段落仅作历史对照。
4. **机检**：本目录纳入 `pnpm ci:unit:docs-freshness`（schema 版本字面量、`pnpm` 脚本存在性、相对链接、已删机制残留、文首状态与同步日期；PR 2 起另检需求定义唯一、追溯矩阵覆盖与悬空引用）。机检覆盖不到语义与锚点正确性，as-built 与代码是否一致仍需人工核对；测试通过不等于规格语义正确。
5. **发版前保鲜**：按 [`AGENTS.md`](../../AGENTS.md)「发布前的文档保鲜」清单，把本目录与 `DESIGN.md`、[`docs/README.md`](../README.md) 一起核对。

---

## 6. 实施进度（#741）

| PR | 范围 | 状态 |
|----|------|------|
| PR 1 | 本目录骨架、`README.md`（编号规则与维护流程）、ADR 模板；`docs-freshness` 覆盖新目录 | 已落地 |
| PR 2 | 01 系统规格 + `traceability.md`（三条关键链路）；需求 ID / 追溯机检；Windows 路径比较修复 | **已落地** |
| PR 3 | 02 / 03 / 10：上下文、约束原则、安全与信任边界 | 待办 |
| PR 4 | 05 / 06 / 07 / 08：构件、运行时、部署、数据视图 | 待办 |
| PR 5 | 04 / 09 / 11 / 12 + 首批 6 条 ADR；`AGENTS.md`、`CLAUDE.md`、`DESIGN.md`、`docs/README.md` 入口更新，`docs/ARCHITECTURE.md` 文首状态说明 | 待办 |
