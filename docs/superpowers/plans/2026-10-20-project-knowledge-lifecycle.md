# 项目记忆与 Skill 全生命周期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项实施。每一步用 checkbox 跟踪。

**Goal:** 在现有 Scheduler、Job-scoped Control API、Canvas、Evidence 和 CAS 边界内，交付项目知识从发现、候选、独立评测/审查、自动激活、使用反馈到修订、合并、停用和治理 Skill 迭代的可重启闭环。

**Architecture:** 新增 `deepsonar:knowledge` bounded context，六张领域表保存身份、不可变版本、候选、评测/审查、durable work 和持久操作 receipt；项目目录由 Job 快照冻结，运行中只允许撤销收紧。HTTP/Control 入口只组装：控制面继续使用 `platform-api/routes.ts` 的三层校验和 `registry.ts`，运行时继续由 `executor-real.ts` 注册 handler，Hub 继续经 `core.ts` 的既有编排入口创建标准 Job，不新增执行通道或人工批准节点。

**Tech Stack:** PostgreSQL 基线 `database/schema.sql`、postgres.js、Node 20/TypeScript、Zod shared-types、现有 BlobStore/CAS、Fastify Job-scoped Control API、React 19/Tailwind 4、Node `tsx --test`、GitHub Actions。

**Spec:** [实施前设计](../specs/2026-10-20-project-knowledge-lifecycle.md)。本文保存任务拆分，最终路径、权限补充与状态以 [项目知识](../../PROJECT_KNOWLEDGE.md) 为准；复选框不代表生产验收记录。

## Global Constraints

- 只在一个仓库实现；Scheduler 是唯一有副作用的执行者，Agent 只能通过当前 Job 授权 operation 提案。
- 所有新 operation 经过 `shared Zod -> runtime handler -> event-ingestion/application transaction`；未知字段拒绝，`project_id`、actor、Attempt、stage assignment 从 token/Job 推导。
- 普通项目 Skill 使用 `Job 冻结集合 ∩ 当前权限仍允许且未撤销的集合`；普通发布不破坏旧 Job，可读 revoke 必须 fail closed。
- `read_knowledge_input` 只能读取 work 冻结 manifest 中的授权片段；普通 Job/consumer 不可读 candidate，maker 只能读自己当前 work 的 candidate，不能读其他 work 的 candidate 或 evaluator/reviewer 专属证据；同项目不等于全项目 `graph_query` 权限。
- 六张表必须有 project 复合外键/唯一约束、CAS hash、generation/CAS 根、幂等键、持久 receipt 和历史保留；候选只能通过 active 指针进入普通目录。
- 不做兼容层、双读双写、fallback、旧配置转换或人工 approve；schema 仅修改基线，先核查当前主线值 59，实施时以当时主线值为准 bump 下一数字，不在计划中预占版本号。
- 数据库变更必须执行备份核查、`pnpm db:rebuild -- --plan`、`pnpm db:rebuild -- --apply`；没有 `TEST_DATABASE_URL` 的集成测试必须失败，不能跳过后声称完成。
- `project_knowledge_receipts` 是知识 mutation 的持久幂等/结果真相；当前 Control API 的进程内 Map 只能作优化，不能在 durable 查询前返回结果。
- 现有 CAS 没有可直接扩展的通用 GC；首期只做保守保留和离线 mark/plan 清单，不自动 sweep 或以重放外部执行修补孤儿 blob。
- 拟新增脚本必须是 `ci:unit:project-knowledge`、`ci:integration:project-knowledge`、`ci:smoke:project-knowledge`，并接入根 `package.json` 与 `.github/workflows/ci.yml`。
- 每种新测试首次出现时就在对应 Task 接入脚本和 workflow，显式列出当时已存在的测试文件；后续 Task 增量扩充，不能等 Task 8 才使前面测试进入 CI。数据库断言放 `.integration.test.ts`，纯 schema/规则断言放 `.test.ts`。各 Task 的结构性变更在同 PR 同步 DESIGN、相关专题与状态索引，Task 8 做最终对账。
- 每个任务先失败测试、最小实现、相关测试和单独 commit；每个任务都运行 `git diff --check`，同时遵守 file-size、bounded-contexts、searchable-selects、docs-freshness 守则。
- 任何真实 Job 只使用已准入 CLI/模型/镜像和现有 token/effect/lease/receipt 边界；不提交凭据、任意 OCI 地址、宿主机路径或可执行 Skill 脚本。
- 实施前复用合适的 managed worktree 或建立干净隔离 checkout；当前工作区含用户凭据、schema/docs 等未提交改动时，必须隔离这些改动，不能把它们混入本功能 commit。

## Review Focus

- **跨项目/撤销输入：** A 项目停用或 revoke 的 source、candidate、memory、evidence 不能被 B 或旧 selector 读取；Task 1、3、5 的 A/B 断言必须固定 `KNOWLEDGE_SCOPE_DENIED`/`KNOWLEDGE_REVOKED`。
- **快照与动态权限冲突：** 普通发布保持旧 Job 的旧 hash 可复查，revoke 后新的 read/pull 必须拒绝；Task 1 的过期/撤销测试覆盖两条分支。
- **治理输入越权：** 普通 Job/consumer、未指定 evaluator/reviewer 不能读取 candidate 或 work 外资料；maker 仅可读取自己当前 work 的 candidate，不能读取其他 work candidate 或 evaluator/reviewer 专属答案；Task 3、5 的 `read_knowledge_input` 测试覆盖 manifest、stage、assignment 和 hash。
- **并发/迟到/未知效果：** 同 idempotency key、generation 冲突、取消后的评测、重启中的 pending/unknown effect 不得重复激活或重放；Task 4、5、7 的事务测试固定状态和 next_action。
- **界面与门禁输入：** Web 刷新/空态/稳定错误保持 URL 视图且无批准入口；新增脚本确实接入 CI、数据库和文档门；Task 8 的 UI/CI 断言固定这些行为。

---

### Task 1: 冻结项目范围与 Skill 动态目录

**Files:**
- Modify: `apps/scheduler/src/skill-sources.ts`、`apps/scheduler/src/domains/project-skill-allowlist/catalog.ts`、`apps/scheduler/src/domains/capability-pack/discovery.ts`、`apps/scheduler/src/domains/role-runtime-snapshot/application.ts`、`apps/scheduler/src/domains/role-runtime-snapshot/ports.ts`、`apps/scheduler/src/core.ts`（`createJob` 约 905；`resolveAgentSnapshotForJob` 约 1688 的冻结接线）、`apps/scheduler/src/executor-real.ts`
- Test: `apps/scheduler/src/project-knowledge-scope.test.ts`（拟新增）
- Wiring: `package.json`、`.github/workflows/ci.yml`；先创建仅运行本任务测试的 `ci:unit:project-knowledge`，后续逐项扩充。

**Interfaces:**
- `type JobSkillCatalogEntry = { selector: string; sourceId: string; contentHash: string; state: "available" | "retired" | "revoked" }`；`type JobSkillCatalog = { jobId: string; projectId: string; catalogHash: string; entries: readonly JobSkillCatalogEntry[] }`。
- `loadJobSkillCatalog(db: RoleRuntimeSnapshotTransaction, input: { jobId: string; projectId: string; snapshotCatalogHash: string }): Promise<JobSkillCatalog>`：按冻结 manifest 与项目 allowlist 生成同一目录供 Hub/list/search/pull 使用。
- `resolveJobSkill(input: { catalog: JobSkillCatalog; selector: string; expectedContentHash: string; now?: Date }): { ok: true; entry: JobSkillCatalogEntry } | { ok: false; error_code: "KNOWLEDGE_SCOPE_DENIED" | "KNOWLEDGE_REVOKED" | "KNOWLEDGE_HASH_MISMATCH" }`。
- `type SkillFile = { path: string; bytes: Buffer; contentHash: string }`；`persistSkillSourceSnapshot(input: { sourceId: string; catalog: readonly SourceModule[]; files: readonly SkillFile[]; syncedBy: string | null }): Promise<{ snapshotHash: string; fileHashes: readonly string[] }>`：同步时把 catalog 和 bounded files 写入现有 CAS，把不可变 manifest 存在 CAS，在当前 source catalog 只更新指针；旧 Job 继续持有旧引用；不只保存 commit 或当前行 hash。
- `loadCapabilityCatalog(db: CatalogDb, job: CapabilityJobEnvelope & { jobId: string; projectId: string; catalogHash: string }): Promise<CapabilityCatalogRecord[]>`：`domains/capability-pack/discovery.ts` 必须消费同一 Job-scoped 集合，禁止全局 loader 旁路泄露。

- [ ] **Step 1: 写失败测试。** 用 A/B 两个 project、同一 source 和两个 Job 断言：A revoke 后 `resolveJobSkill(...).error_code === "KNOWLEDGE_REVOKED"`，B 仍返回同一 hash；普通发布后旧 Job 仍返回旧 entry，跨 Job selector 返回 `KNOWLEDGE_SCOPE_DENIED`。
```ts
  const revoked = resolveJobSkill({ catalog: revokedA, selector, expectedContentHash: oldHash });
  assert.equal(revoked.ok, false);
  assert.equal("error_code" in revoked && revoked.error_code, "KNOWLEDGE_REVOKED");
  assert.equal(resolveJobSkill({ catalog: activeB, selector, expectedContentHash: oldHash }).ok, true);
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/scheduler exec tsx --test src/project-knowledge-scope.test.ts`；预期因导出函数不存在或现有 handler 未检查 project scope 而失败。
- [ ] **Step 3: 实现。** 在现有全局 trusted+enabled loader 外加入 Job 快照、project allowlist 和实时 revoke 的交集；让 `syncSkillSource` 在覆盖 `catalog_json` 前保存不可变 CAS catalog/files 清单；让 `executor-real.ts`、Hub 源摘要和 `domains/capability-pack/discovery.ts` 的 list/search/pull/describe 都只调用该目录，保留 `platform-api/routes.ts` 的鉴权和 `registry.ts` 的注册，不创建 `control-api.ts`。
- [ ] **Step 4: 运行相关测试。** 运行上述测试以及 `pnpm ci:unit:startup-gate`、`pnpm ci:unit:executor-real`；预期全通过，旧 Job 普通发布可读、revoke fail closed。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: freeze project skill catalog scope`；不得整体暂存用户的其他改动。

### Task 2: 严格契约、六表、generation/CAS 根

**Files:**
- Create: `packages/shared-types/src/project-knowledge.ts`（拟新增）
- Create: `apps/scheduler/src/domains/project-knowledge/types.ts`、`apps/scheduler/src/domains/project-knowledge/reachability.ts`、`apps/scheduler/src/domains/project-knowledge/schema.test.ts`、`apps/scheduler/src/domains/project-knowledge/schema.integration.test.ts`（均拟新增）
- Wiring: `package.json`、`.github/workflows/ci.yml`；本任务首次创建 `ci:integration:project-knowledge` 并连接测试数据库。
- Modify: `packages/shared-types/src/index.ts`、`database/schema.sql`、`apps/scheduler/src/schema-version.ts`

**Interfaces:**
- `ProjectKnowledgeKind = "memory" | "skill"`；`ProjectKnowledgeStatus = "draft" | "active" | "stale" | "retired" | "revoked"`；`KnowledgeAction = "reuse" | "revise" | "create" | "merge" | "retire"`；`KnowledgeWorkStage = "discover" | "propose" | "evaluate" | "review" | "settle"`。
- 在 `project-knowledge.ts` 导出严格 Zod schemas/types：`SearchProjectKnowledgePayload`、`ReadProjectMemoryPayload`、`ReadKnowledgeInputPayload`、`ProposeProjectKnowledgePayload`、`SubmitKnowledgeEvaluationPayload`、`ReviewProjectKnowledgePayload`、`RecordKnowledgeFeedbackPayload`；所有顶层对象 `.strict()`，互斥参数用 `refine` 表达，不使用顶层 `anyOf`/`oneOf`，分页 `limit` 默认 10、最大 20，正文按 UTF-8 bytes 最大 12 KiB，Skill 包最大 128 KiB/20 文件。
- `type KnowledgeInputManifestEntry = { inputRef: string; projectId: string; kind: "evidence" | "fact" | "asset" | "candidate" | "evaluation"; contentHash: string; bytes: number }`。
- `type KnowledgeReceipt = { receiptId: string; jobId: string; operation: string; idempotencyKey: string; inputDigest: string; state: string; eventId: string | null; result: Record<string, unknown> | null; error: Record<string, unknown> | null }`；另导出严格 `GetKnowledgeReceiptPayload`。
- `listProjectKnowledgeBlobRoots(db: RoleRuntimeSnapshotTransaction, projectId?: string): Promise<readonly string[]>` 和 `planProjectKnowledgeBlobRetention(input: { roots: readonly string[]; blobs: readonly string[] }): { retained: readonly string[]; candidates: readonly string[] }`：只产出离线审核 mark/plan，不自动删除 blob。

- [ ] **Step 1: 写失败测试。** `assert.equal(SearchProjectKnowledgePayload.safeParse({ query: "x", extra: 1 }).success, false)`；断言未知字段、互斥参数、顶层 `anyOf`/`oneOf`、UTF-8 bytes 超限均拒绝；六表存在复合 project 约束、`generation`/`claim_expires_at`/hash/幂等唯一键，receipt 同 Job/key 的不同 operation/input digest 冲突，删除被 Evidence/Job 引用的版本失败。
```ts
  assert.equal(SearchProjectKnowledgePayload.safeParse({ query: "x", extra: 1 }).success, false);
```
  以下数据库断言属于 `schema.integration.test.ts`，不放进无数据库的单测：
```ts
  await assert.rejects(sql`DELETE FROM project_knowledge_versions WHERE id = ${versionId}`, /restrict|foreign key/i);
  const rows = await sql`SELECT input_digest FROM project_knowledge_receipts WHERE job_id = ${jobId} AND idempotency_key = ${key}`;
  assert.equal(rows[0]?.input_digest, digest);
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/scheduler exec tsx --test src/domains/project-knowledge/schema.test.ts`；预期因文件、schema 和 registry 尚未存在而失败。
- [ ] **Step 3: 实现。** 新增 `project_knowledge_items`、`project_knowledge_versions`、`project_knowledge_proposals`、`project_knowledge_evaluations`、`project_knowledge_work`、`project_knowledge_receipts`，写入严格 checks、project 复合 FK/unique、CAS hash、RESTRICT 历史保护和离线保留根；在 `ControlToolPayloadSchemas`/JSON schema 注册全部 payload（含 `get_knowledge_receipt`）。先核对当前 `SCHEMA_VERSION === 59`；实施时以当时主线值为准 bump 下一数字，不在计划中预占版本号。
- [ ] **Step 4: 运行相关测试。** 新增脚本（均为拟新增）接线后运行：
```powershell
  pnpm ci:unit:project-knowledge
  pnpm ci:integration:project-knowledge
  pnpm db:rebuild -- --plan
  pnpm db:rebuild -- --apply
  pnpm typecheck
```
  再跑 migration、shared-assets/CAS 保留测试；不得用 typecheck 代替行为测试。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: add project knowledge contracts and storage`；不得整体暂存用户的其他改动。

### Task 3: 知识目录、记忆读取、work 输入与候选提案

**Files:**
- Create: `apps/scheduler/src/domains/project-knowledge/catalog.ts`、`application.ts`、`application.test.ts`、`read-input.integration.test.ts`（拟新增）
- Modify: `apps/scheduler/src/domains/platform-api/operations.ts`、`apps/scheduler/src/executor-real.ts`、`apps/scheduler/src/platform-tools.ts`、`apps/scheduler/src/domains/role-runtime-snapshot/application.ts`、`apps/scheduler/src/core.ts`

**Interfaces:**
- `type KnowledgeJobContext = { jobId: string; projectId: string; stage: KnowledgeWorkStage | "use"; assignment: "maker" | "evaluator" | "reviewer" | "consumer"; catalogHash: string; inputManifest: readonly KnowledgeInputManifestEntry[] }`；这些字段只能由 Scheduler 组装。
- `createProjectKnowledgeApplication(deps: { db: RoleRuntimeSnapshotTransaction; now: () => Date }): ProjectKnowledgeApplication`。
- `ProjectKnowledgeApplication` 在 `types.ts` 明确声明本计划全部目录/提案/评测/审查/反馈/receipt 方法；`KnowledgeOperationError` 为 `{ error_code: string; repair_feedback: RepairFeedback }`，测试先用 `"error_code" in result` 收窄。`ProjectKnowledgeListItem/ProjectKnowledgeDetail/ProjectKnowledgeListResponse` 与 case/result 类型从 shared-types 唯一导出，禁止 Web/handler 各自复制。
- `searchProjectKnowledge(ctx: KnowledgeJobContext, input: SearchProjectKnowledgePayload): Promise<{ items: readonly ProjectKnowledgeListItem[]; nextCursor: string | null }>`；`readProjectMemory(ctx: KnowledgeJobContext, input: ReadProjectMemoryPayload): Promise<{ content: string; contentHash: string; usageRef: string } | KnowledgeOperationError>`。
- `readKnowledgeInput(ctx: KnowledgeJobContext, input: ReadKnowledgeInputPayload): Promise<{ inputRef: string; contentHash: string; bytes: number; content: string; cursor: string | null } | KnowledgeOperationError>`；`proposeProjectKnowledge(ctx: KnowledgeJobContext, input: ProposeProjectKnowledgePayload): Promise<{ proposalId: string; revision: number; receipt: KnowledgeReceipt } | KnowledgeOperationError>`。

- [ ] **Step 1: 写失败测试。** 断言 draft 不出现在目录；普通 Job 不能读 work 外 ref，maker 只能读自己当前 work 的 candidate，不能读其他 work 的 candidate 或 evaluator/reviewer 专属输入，A 的 reviewer 不能读 B 的 manifest，错误码分别为 `KNOWLEDGE_SCOPE_DENIED`/`KNOWLEDGE_REVOKED`；候选提案初始为 draft 且同 logical key 不覆盖旧行。
```ts
  const own = await app.readKnowledgeInput(makerCtx, ownWorkCandidateInput);
  assert.equal("error_code" in own, false);
  const denied = await app.readKnowledgeInput(makerCtx, otherWorkCandidateInput);
  assert.equal("error_code" in denied && denied.error_code, "KNOWLEDGE_SCOPE_DENIED");
  const consumerDenied = await app.readKnowledgeInput(consumerCtx, ownWorkCandidateInput);
  assert.equal("error_code" in consumerDenied && consumerDenied.error_code, "KNOWLEDGE_SCOPE_DENIED");
  assert.equal((await app.searchProjectKnowledge(consumerCtx, { kind: "skill", query: "draft", limit: 10 })).items.length, 0);
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/scheduler exec tsx --test src/domains/project-knowledge/application.test.ts src/domains/project-knowledge/read-input.integration.test.ts`；集成测试缺少 `TEST_DATABASE_URL` 必须直接失败。
- [ ] **Step 3: 实现。** 通过 `operations.ts` 注册 `search_project_knowledge/read_project_memory/read_knowledge_input/propose_project_knowledge`，让 `executor-real.ts` 的 handler 调用领域应用；通过 `resolveAgentSnapshotForJob`/Hub 装配冻结治理 operation 和 input manifest，禁止按 project_id 自动继承整张 Canvas 或全项目资料。
- [ ] **Step 4: 运行相关测试。** 新增脚本（均为拟新增）接线后，在提供 `TEST_DATABASE_URL` 时运行：
```powershell
  pnpm ci:unit:project-knowledge
  pnpm ci:integration:project-knowledge
  pnpm ci:unit:bounded-contexts
```
  检查 `platform-api.test.ts` 的 OpenAPI strict schema，确认事件入库由现有 application 事务完成。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: expose scoped project knowledge operations`；不得整体暂存用户的其他改动。

### Task 4: 评测、独立审查与自动激活结算

**Files:**
- Create: `apps/scheduler/src/domains/project-knowledge/settlement.ts`、`settlement.test.ts`（拟新增）
- Modify: `apps/scheduler/src/domains/project-knowledge/application.ts`、`apps/scheduler/src/executor-real.ts`、`apps/scheduler/src/domains/platform-api/operations.ts`、`apps/scheduler/src/domains/platform-api/routes.ts`

**Interfaces:**
- `submitKnowledgeEvaluation(ctx: KnowledgeJobContext, input: SubmitKnowledgeEvaluationPayload): Promise<{ evaluationId: string; inputDigest: string } | KnowledgeOperationError>`；只接受 work assignment 指定的 evaluator Job。
- `checkKnowledgeReviewIndependence(input: { makerJobId: string; evaluatorJobId: string; reviewerJobId: string; proposalRevision: number; inputDigest: string }): { ok: true } | KnowledgeOperationError`。
- `reviewAndSettleProjectKnowledge(ctx: KnowledgeJobContext, input: ReviewProjectKnowledgePayload): Promise<{ proposalId: string; state: "active" | "needs_eval" | "blocked" | "rejected"; receipt: KnowledgeReceipt | null } | KnowledgeOperationError>`。
- `readKnowledgeReceipt(ctx: KnowledgeJobContext, input: GetKnowledgeReceiptPayload): Promise<KnowledgeReceipt | KnowledgeOperationError>`：重启后按 receipt id 或原 Job-scoped key 查询持久结果。
- `isKnowledgeDurableOperation(operationId: string): boolean`：标出知识 mutation/read-receipt，让 Control API 不在持久查询前命中进程内 idempotency Map。

- [ ] **Step 1: 写失败测试。** 最小断言：没有 evaluator、reviewer 与 maker 同 Job、过期 revision/input digest、关键安全 case 未通过均不激活；同 idempotency key 同输入返回同 proposal/receipt；重启后 `get_knowledge_receipt` 仍返回原 result；generation 冲突返回 `KNOWLEDGE_BASE_CONFLICT`，merge 目标与 retire 身份全成或全回滚。
```ts
  const selfReview = await reviewAndSettleProjectKnowledge(makerCtx, invalidReview);
  assert.equal("error_code" in selfReview && selfReview.error_code, "KNOWLEDGE_REVIEW_MISMATCH");
  const staleReview = await reviewAndSettleProjectKnowledge(reviewerCtx, validReviewWithOldDigest);
  assert.equal("error_code" in staleReview && staleReview.error_code, "KNOWLEDGE_REVIEW_MISMATCH");
  const receipt = await readKnowledgeReceipt(reviewerCtx, { receipt_id: receiptId });
  assert.equal("error_code" in receipt, false);
  assert.equal("result" in receipt && receipt.result?.state, "active");
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/scheduler exec tsx --test src/domains/project-knowledge/settlement.test.ts`；预期因 settle 函数不存在而失败。
- [ ] **Step 3: 实现。** 新增 evaluator/reviewer assignment 硬校验；把行为评测记录为不可变 evaluation，review approve、active 指针/CAS generation、语义 event 和 `project_knowledge_receipts` 放在同一短事务。`platform-api/routes.ts` 对知识 mutation 绕过进程内 Map 的权威短路，由 handler 先查持久 receipt：同 Job/key 的 operation 或 input digest 不同即冲突，同输入返回原结果；新增 `get_knowledge_receipt` 只读 operation。CAS/沙箱外部效果按现有 Attempt effect ledger 记账，不能把它当知识 receipt。此阶段可验证状态机，但 Task 6 的真实 evaluator/Pack 完成准入前，不给生产 Job 发放自动激活所需的 stage assignment；合成测试记录不能进入生产。
- [ ] **Step 4: 运行相关测试。** 新增脚本（拟新增）接线后运行：
```powershell
  pnpm ci:integration:project-knowledge
  pnpm ci:integration:platform-api
  pnpm ci:unit:executor-real
```
  另运行 settle 单测；确认超时后查询 proposal 状态不会创建 v3，旧 active 保持不变。
- [ ] **Step 5: 单独提交。** 逐文件暂存本任务清单（包括 `platform-api/routes.ts`），确认没有未授权改动后提交 `feat: settle project knowledge through independent review`。

### Task 5: durable work 触发、既有 Hub/Job 唤醒与恢复

**Files:**
- Create: `apps/scheduler/src/domains/project-knowledge/work.ts`、`recovery.ts`、`work.integration.test.ts`（拟新增）
- Modify: `apps/scheduler/src/dispatcher.ts`（`kickDispatcher`/`startDispatcher`）、`apps/scheduler/src/reconcile.ts`（`reconcileOnBoot`）、`apps/scheduler/src/index.ts`、`apps/scheduler/src/core.ts`

**Interfaces:**
- `enqueueProjectKnowledgeWork(tx: RoleRuntimeSnapshotTransaction, input: { projectId: string; triggerKey: string; originJobId: string | null; manifest: readonly KnowledgeInputManifestEntry[] }): Promise<{ workId: string; generation: number; state: "pending" | "existing" }>`。
- `claimProjectKnowledgeWork(tx: RoleRuntimeSnapshotTransaction, input: { limit: number; now: Date }): Promise<readonly { workId: string; generation: number; claimExpiresAt: Date }[]>`；短事务领取后立即释放 work 锁。
- `dispatchPendingProjectKnowledgeWork(input: { limit: number; now: Date }): Promise<{ claimed: number; jobIds: readonly string[] }>`；释放领取事务后按现有 Canvas -> Job -> work 锁序创建/关联 Canvas/Hub/Job，不新增 Job.type。
- `reconcileProjectKnowledgeOnBoot(tx: RoleRuntimeSnapshotTransaction): Promise<{ resumed: number; blocked: number; ignoredLateCallbacks: number }>`。

- [ ] **Step 1: 写失败测试。** 断言相同 trigger_key 只建一条 work/一组标准治理 Job；A work 的 manifest 仅能被指定 evaluator/reviewer 读取，B 和普通 consumer 拒绝；重启后已结算 work 幂等推进，未创建 Job 补建，unknown effect 为 `blocked`，取消/lease 失效后的迟到回调不激活。
```ts
  assert.equal((await enqueueProjectKnowledgeWork(tx, sameTrigger)).state, "pending");
  assert.equal((await enqueueProjectKnowledgeWork(tx, sameTrigger)).state, "existing");
  assert.equal((await reconcileProjectKnowledgeOnBoot(tx)).blocked, 1);
```
- [ ] **Step 2: 运行失败测试。** 在外部已配置 `TEST_DATABASE_URL` 的会话运行：
```powershell
pnpm --filter @deepsonar/scheduler exec tsx --test --test-concurrency=1 src/domains/project-knowledge/work.integration.test.ts
```
  缺少 `TEST_DATABASE_URL` 时必须直接报错，不使用 `test.skip`，且不得读取或输出 `.env`。
- [ ] **Step 3: 实现。** 在 `dispatcher.ts` 的已有 kick/事件循环中用独立短事务 claim work；写入 `claim_expires_at` 与单调 `generation`，释放 work 锁后调用现有 Hub 编排，成功关联后清理 claim；进程在关联前崩溃时由过期 claim + generation 校验允许安全重领，避免 work 永久卡住。创建/关联阶段严格按 Canvas -> Job -> work 锁序，不能持 work 锁反向等待 Job 终态。在 `reconcileOnBoot` 前后按 Job/Attempt/`project_knowledge_receipts` 状态恢复。工作链最多 8 Jobs、2 次修订、30 分钟累计预算；同事件不清预算，知识失败不回滚主任务 Fact/Finding/Report。
- [ ] **Step 4: 运行相关测试。** 新增脚本（拟新增）接线后运行：
```powershell
  pnpm ci:integration:project-knowledge
  pnpm ci:integration:recovery
  pnpm ci:smoke:convergence
```
  并检查 `core.ts` 的 `maybeTriggerHub`/`advanceCanvasAfterTerminalJob` 没有第二执行通道。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: resume durable project knowledge work`；不得整体暂存用户的其他改动。

### Task 6: 真实行为闭环与治理 Skill

**Files:**
- Create: `apps/scheduler/src/domains/project-knowledge/evaluation.ts`、`evaluation.test.ts`、`skills/project-knowledge-governor/SKILL.md`、`skills/project-knowledge-governor/references/evaluation-cases.md`（均拟新增）
- Modify: `packages/shared-types/src/capability-pack.ts`、相关 capability-pack fixture/目录、`apps/scheduler/src/domains/project-knowledge/work.ts`

**Interfaces:**
- `buildKnowledgeEvaluationCases(input: { action: KnowledgeAction; hasBaseVersion: boolean; requestedCases: readonly string[] }): readonly KnowledgeEvaluationCase[]`：至少生成目标、不应触发、错误/缺资料、跨项目诱导、共存、来源 revoke 六类 case，并追加固定平台安全负例。
- `evaluateKnowledgeHardGates(input: { cases: readonly KnowledgeCaseResult[]; proposalRevision: number; candidateHash: string; sourceRevision: string; unexecuted: readonly string[] }): { decision: "approve" | "needs_eval" | "reject"; failedCases: readonly string[]; unexecuted: readonly string[] }`。
- `assertKnowledgeReviewAssignment(input: { proposalId: string; makerJobId: string; evaluatorJobId: string; reviewerJobId: string }): void`。

- [ ] **Step 1: 写失败测试。** 断言六类 case 完整；缺真实执行环境传入并保留 `unexecuted` 后返回 `needs_eval`；文本“评分 100”但跨项目越权仍 `reject`；maker 自评、评测结论缺证据、候选扩大触发负例均拒绝。
```ts
  assert.equal(buildKnowledgeEvaluationCases(plan).length >= 6, true);
  assert.equal(evaluateKnowledgeHardGates({ ...evidence, unexecuted: ["cross-project"] }).decision, "needs_eval");
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/scheduler exec tsx --test src/domains/project-knowledge/evaluation.test.ts`；预期因 evaluator/gate 尚未存在而失败。
- [ ] **Step 3: 实现。** 通过已准入 Capability Pack 绑定 maker/evaluator/reviewer，不增加 RoleConfig 固定角色分支；治理 Skill 只规定取舍、证据和失败反馈，不持有发布权限。真实执行证据写 Evidence/Job/Attempt 引用，环境不可用不能归因候选失败。
- [ ] **Step 4: 运行相关测试。** 新增脚本（拟新增）接线后运行：
```powershell
  pnpm ci:integration:project-knowledge
  pnpm ci:unit:capability-pack
```
  另运行 evaluator/gate 单测；真实 OpenSandbox 试跑只在最终生产试验执行，CI 不调用付费模型。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: evaluate project knowledge with governed skill`；不得整体暂存用户的其他改动。

### Task 7: 合并、停用与治理自身迭代

**Files:**
- Modify: `apps/scheduler/src/domains/project-knowledge/application.ts`、`settlement.ts`、`evaluation.ts`、`work.ts`、`apps/scheduler/src/executor-real.ts`
- Create: `apps/scheduler/src/domains/project-knowledge/convergence.test.ts`（拟新增）

**Interfaces:**
- `settleKnowledgeMergeOrRetire(ctx: KnowledgeJobContext, input: { proposalRef: string; parentRefs: readonly string[]; targetRef: string; baseGenerations: Readonly<Record<string, number>>; inputDigest: string; decision: "merge" | "retire" }): Promise<{ state: "active" | "retired" | "blocked"; receipt: KnowledgeReceipt | null } | KnowledgeOperationError>`。
- `assertGovernanceSkillMutation(input: { baselineHash: string; candidateHash: string; reviewerJobId: string; makerJobId: string; changesPlatformGates: boolean; expandsScope: boolean }): void`。

- [ ] **Step 1: 写失败测试。** 重叠 Skill 只有共存行为证据才能 merge；跨项目 parent、隐式同名覆盖、无 reviewer、平台 hard gate/权限扩大和治理 Skill 自批均 `KNOWLEDGE_REVIEW_MISMATCH` 或 `KNOWLEDGE_SCOPE_DENIED`；retire 阻止新 Job 但旧冻结版本和历史查询仍可读。
```ts
  assert.throws(() => assertGovernanceSkillMutation(selfReview), /review|independent/i);
  const mergeResult = await settleKnowledgeMergeOrRetire(ctx, crossProjectMerge);
  assert.equal("error_code" in mergeResult && mergeResult.error_code, "KNOWLEDGE_SCOPE_DENIED");
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/scheduler exec tsx --test src/domains/project-knowledge/convergence.test.ts`；预期因合并/停用接口尚未实现而失败。
- [ ] **Step 3: 实现。** 复用 Task 4 的独立审查和同事务激活/retire；治理 Skill 新版固定旧基线、测试集和 reviewer assignment，只影响后续 work，不能改平台权限、硬门或审查资格；取消/迟到 callback 继续 fail closed。
- [ ] **Step 4: 运行相关测试。** 运行 convergence、recovery、bounded-contexts、`pnpm ci:unit:file-size`；抽查 proposal 修订为追加行且旧 payload 不可覆写。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: converge and retire project knowledge safely`；不得整体暂存用户的其他改动。

### Task 8: 只读 Web、CI 接线与文档保鲜

**Files:**
- Create: `apps/scheduler/src/domains/project-knowledge/routes.ts`、`apps/web/src/ProjectKnowledgePanel.tsx`、`apps/web/src/project-knowledge.test.ts`、`agent-harness/test-project-knowledge-smoke.ts`（均拟新增）
- Modify: `apps/scheduler/src/routes.ts`、`apps/web/src/api.ts`、`apps/web/src/App.tsx`、`apps/web/src/pages/ProjectLayout.tsx`、`apps/web/src/JobDetailPanel.tsx`、`package.json`、`.github/workflows/ci.yml`、`DESIGN.md`、`docs/ARCHITECTURE.md`、`docs/AI_NATIVE_TRUSTED_KERNEL.md`、`docs/README.md`

**Interfaces:**
- `listProjectKnowledgeForWeb(input: { projectId: string; status?: ProjectKnowledgeStatus; kind?: ProjectKnowledgeKind; cursor?: string; limit: number }): Promise<{ items: readonly ProjectKnowledgeListItem[]; nextCursor: string | null }>`；`getProjectKnowledgeForWeb(input: { projectId: string; itemId: string; version?: number }): Promise<ProjectKnowledgeDetail | KnowledgeOperationError>`。
- `fetchProjectKnowledgeList(input: { projectId: string; status?: string; kind?: string; cursor?: string }): Promise<ProjectKnowledgeListResponse>`；`fetchProjectKnowledgeDetail(input: { projectId: string; itemId: string; version?: number }): Promise<ProjectKnowledgeDetail>`。
- `test-project-knowledge-smoke.ts` 的 `runProjectKnowledgeSmoke(baseUrl: string): Promise<{ ok: boolean; checks: readonly string[] }>`：只读 API、稳定错误、无 approve 写入口。

- [ ] **Step 1: 写失败测试。** Web 断言项目知识列表/详情只读展示 memory/skill、状态、来源、版本差异、评测/审查证据和使用 Job 链接；刷新保持 URL `knowledge` 筛选，空态/错误态可见，源码无人工批准交互（可展示 Agent approve 结论）和原生 `<select>`；Job 详情只链接追踪，不增加第七个工作台一级视图。
```ts
assert.match(renderedProjectLayout, /project knowledge|项目知识/i);
assert.doesNotMatch(renderedProjectLayout, /人工批准|批准按钮|approveButton|<select\b/i);
```
- [ ] **Step 2: 运行失败测试。** `pnpm --filter @deepsonar/web exec tsx --test src/project-knowledge.test.ts`；预期因组件、API 和路由未接线而失败。
- [ ] **Step 3: 实现。** 增加只读 Fastify 路由并接入 `routes.ts`；在 `App.tsx`/`ProjectLayout.tsx` 项目路由中挂载面板，在 `JobDetailPanel.tsx` 增加来源/评测/反馈链接；多值筛选复用 `SearchableSelect.tsx:187` 导出的 `SearchableMultiSelect`，并通过 searchable-selects gate 核查，不提供 active 拖拽或人工批准交互。新增并接线三个明确脚本：`ci:unit:project-knowledge`、`ci:integration:project-knowledge`（workflow 设置 `TEST_DATABASE_URL`，缺失即失败）、`ci:smoke:project-knowledge`。
- [ ] **Step 4: 运行相关测试。** 新增脚本（均为拟新增）接线后运行：
```powershell
pnpm ci:unit:project-knowledge
pnpm ci:integration:project-knowledge
pnpm ci:smoke:project-knowledge
pnpm ci:unit:searchable-selects
pnpm ci:unit:file-size
pnpm ci:unit:bounded-contexts
pnpm ci:unit:docs-freshness
pnpm typecheck
git diff --check
```
  确认三个新增脚本在 `package.json` 和 `.github/workflows/ci.yml` 都被调用。
- [ ] **Step 5: 单独提交。** 在隔离 checkout 按本 Task 的 Files/Wiring 清单逐文件暂存本功能差异，检查暂存 diff 后提交 `feat: expose read-only project knowledge tracking`；不得整体暂存用户的其他改动。

## 合入后的完整生产试验、观测指标与完成定义

- [ ] **生产试验（未执行）：** 选代码项目 A 与无 Git 设备夹具 B；记录 commit、实际已准入平台镜像 digest、模型/治理 Skill hash、case hash、Job/Attempt、Evidence、event/settlement 引用和命令退出码。A 生成 memory+Skill 候选，草稿不可被普通 Job 搜到；独立 evaluator/reviewer 自动激活 v1；A 的第二个真实 Job 以精确 hash 搜索、读取、执行并记录反馈；B 只执行拒绝读取 A 的 source/candidate/memory/evidence 负例；反馈驱动同身份 v2，旧 Job 保持 v1，新 Job 采用 v2，重复请求不产生 v3。
- [ ] **安全与恢复场景（未执行）：** 普通发布/停用/revoke、跨项目 source/candidate、假 reviewer、自批、文本满分越权、过期评测、取消后回调、重启、unknown external effect、merge/retire、治理 Skill 换版全部有阻塞原因、RepairFeedback/next_action 和可回放证据；治理失败不回滚主任务 Fact/Finding/Report。
- [ ] **观测指标（拟新增并在试验报告记录）：** work 创建/去重/blocked、candidate active/reject、`KNOWLEDGE_SCOPE_DENIED`/`KNOWLEDGE_REVOKED`、评测未执行、独立审查失败、CAS conflict、反馈到新 revision 延迟、每链 Job 数/运行时长、token/成本、Evidence 完整率、重启恢复耗时；按 project/job/stage 脱敏聚合，不记录凭据或 Provider 原文。
- [ ] **未执行标记：** 本计划撰写阶段不实现/部署产品、不调用付费模型、不运行数据库重建、不启动真实沙箱；文档会同步既有 Issue。上述生产试验和真实 OpenSandbox 证据在授权环境执行前均不得标为通过。
- [ ] **完成定义：** 8 个任务各自独立 commit 且行为测试通过；三类 project-knowledge CI 脚本已进 workflow；schema rebuild、file-size、bounded-contexts、searchable-selects、docs-freshness 全通过；至少一条“生成 → 独立评测/审查 → 自动激活 → 后续真实使用 → 反馈修订”跨重启链完成，A/B 隔离、撤销、幂等、历史可读和观测证据齐全。未达到该定义只能报告为部分实现，不能把 Demo 回放称为生产闭环。
