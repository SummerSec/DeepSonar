# Finding 离线标注评估与积压测量（#770）

> 状态：**#770 offline tooling and the agreed #819 schema67 engineering slice are merged via #831 and accepted at fdb55a01 in Actions; #819 is closed only within that scope. Current certificates, CAS promotion, guarded publication and independent human-quality acceptance remain deferred and not delivered.**
> 收口（2026-10-31）：随 #770 按已交付切片关闭，强关系由 [#819](https://github.com/SummerSec/DeepSonar/issues/819) 独立实现。生产执行按 AGENTS.md「验收边界」豁免，但**不覆盖本文的人工质量验收**：人工质量评估仍记为未执行，工具与合成夹具不因此被解释为质量门通过；阈值提案仍为「待审阅」而非已批准。
> 同步日期：2026-11-01
> **v0.6.3 本轮范围（2026-11-01）**：按[最新用户范围决定](<../AGENTS.md#豁免范围>)，独立质量验证及后续质量门建设（脱敏独立人工标注、家族/资产分离调参与留出、Host 外部证据认证及当前证书、CAS 晋升、公开强关系建议）均暂缓，不作为本轮 PR 合并、工程 issue 收口或发布前置条件。保留已实现工程和现有测试/权限/CAS/不可变/发布抑制边界；工程验收只认最终 SHA 在现有 GitHub Actions 适用检查实际全绿，所有测试、构建和 typecheck 仅在 Actions 执行。质量仍为 `unknown` / `not_evaluated`，强关系 `published=false`；下文历史非豁免及强关系质量要求不表示本轮追加质量卡点，CI 全绿也不等于独立质量通过。

本文承接[特征与候选专题](PROJECT_FINDING_RESEARCH.md)。本切片补充非模型验收工具：本地标注导入/校验、可追溯质量报告、字段覆盖/不足率、强关系摘要映射输入与后台积压资源测量。不导入生产数据库，不调用模型。命令成功只表示报告生成成功，不表示候选算法或强关系满足上线质量。

## 本地数据契约

`pnpm research:evaluate:offline -- --input <本地JSON文件>` 从显式指定的普通文件读取数据并向 stdout 输出 JSON。CLI 不加载数据库配置或 `.env`，不解析或请求证据 URI；错误仅输出有限代码。输入上限4MiB、1000来源、10000标注对，每个来源声明文本合计不超过16k字符；它用于脱敏样本评估，不是项目全量导出工具。

可直接运行[合成格式示例](evidence/770-offline-example.synthetic.json)：

```bash
pnpm --silent research:evaluate:offline -- --input ../../docs/evidence/770-offline-example.synthetic.json > /tmp/finding-evaluation.json
```

该脚本通过 pnpm 在 Scheduler 包目录运行，相对输入路径以 `apps/scheduler` 为基准，也可使用绝对路径。示例标签是程序行为夹具，不是真实人工结论；运行成功不表示阈值通过。

数据集必须提供 schema_version、dataset_id、dataset_kind（synthetic / human-labeled）、metadata（labelset_revision、annotator_ids、labeling_method），以及预声明 config（k、scan_limit、predeclared）。human-labeled 要求匿名审核者与 human-declared 声明，但工具无法证明标注人员独立性或来源真实性；报告明确保留这一限制。synthetic 只能验证工具行为，不能冒充人工评估。

每个来源记录 UUID 身份、项目/Job、tuning或holdout分区、asset_group/family_group、来源revision或digest、title/location/summary/profile/category。identity_declarations 只能统计提交者所提供字段的覆盖，不作为当前生产提取器的权威输入。可选 `authoritative_identity_mappings` 只接受摘要、authority version、source revision/digest 和 freshness，不接受原始身份值；它用于离线重放强关系判定，不能替代平台独立核验。组标识仅用于检查隔离，不证明资产同一性。未知字段用 null，不用相同“unknown”字符串冒充共同身份。

标注对通过两端ID引用来源，label为 suspected_same_issue、same_problem、same_root_cause_different_instance、similar、distinct、insufficient_information 或显式 null。null 表示缺标注，不等于信息不足类别，更不等于明确不同。非法类别、重复/反向对、缺失来源、跨项目或同Job评估对均拒绝。跨 tuning/holdout 的同来源、同资产组或同问题家族拒绝；缺少隔离组也拒绝出具隔离评估。校验只针对提交的标识，不能发现被错误改名或伪造的家族。

同 Job 评估对的拒绝与 tuning/holdout 隔离检查是上述**离线导入契约**，不是部署 SQL 选择条件；同 Job Finding 不因此从实际强关系选择器语料中排除。

## 预测与报告口径

离线程序复用现有确定性词法提取、排名与逐对规则，身份字段仍按生产行为保持未知。标签不参与提取、排名或判定。窗口是本地样本语料的模拟，不是 PostgreSQL 实际项目召回；报告必须保留该范围。支持单次预声明 K=1..50 与扫描预算<=128，生产候选当前为 K=25 / 128。K=10/25/50 可在调参集比较，但程序不会扫描多个配置后用留出分数挑最佳配置。predeclared 是提供者声明，工具不证明配置在时间上先于留出集查看。

报告分别展示：

- **逐对规则**：所有已标注对的各类 TP/FP/FN 与 precision/recall。
- **候选流水线**：词法样本窗口的有向查询机会的召回和后续分类，未召回不能从分母中消失，相关关系的漏召回计 FN。
- **缺失标签**：计数单列；未标注的返回候选不得算 FP。recall@K 仅对该标注集内的正例成立，不是全项目真实召回率。
- **不足与覆盖**：预测信息不足、人工信息不足、未标注和未召回分开；文本与身份声明字段覆盖率报告分子/分母，提供者声明与当前可用权威映射分开。
- **强关系工程重放**：若提供摘要映射，逐对增加 `strong_relation_prediction` 与规则原因；`strong_pair_rule_metrics` 独立使用强预测统计无向标注对，`strong_candidate_pipeline_metrics` 则统计有向词法样本窗口检索后再判强关系的机会，不是实际 SQL identity/root-cause worker 召回。`suspected_same_issue` 与 `same_problem` 显式统一到 `same_problem`；只有同问题、同根因不同实例与 distinct 真值进入强关系评分分母，null、弱 similar 和人工 insufficient 单列而不猜作负例。缺失/过期映射的弃权及窗口漏召回仍是已知强正例的 FN；返回强预测但标签未知的数量单列，不能据条件精确率宣称全语料质量通过。强结果不改变原词法指标、不生成生产建议，也不表示来源映射已独立认证。评估器/强规则/指标版本纳入配置摘要；2026-10-31 合成回归只支持这些工程行为。

所有零分母为 null，不伪造0或1。强关系有真值而当前规则没有可用摘要映射时 recall 为0；没有该类真值时为null。规范化输入、配置与规则版本绑定摘要，逐对输出通过来源ID和摘要追溯；报告不复制原始文本、证据URI或身份声明内容。source.digest/revision 是提交者提供的来源引用，工具没有访问原始系统独立核验；sources[].input_digest 则是本次实际读取的规范化来源行摘要。摘要不是匿名化保证，应按原样本权限保存报告。工具不发布 `passed` 质量结论。

## 共用部署 SQL 选择器的评估边界（2026-11-01）

[持久 worker](../apps/scheduler/src/domains/project-finding-research/relation-computation.ts) 现在调用共用的 [strong-candidate-selector.ts](../apps/scheduler/src/domains/project-finding-research/strong-candidate-selector.ts)，不是另写查询。原始选择条件见[数据架构](architecture/08-data-architecture.md#强关系计算与投影)：有效且有摘要的主体 root cause、同项目 DISTINCT 的当前未撤销 mapping/source 与新鲜 revision 中匹配的根因摘要、仅取更大 UUID 并升序排序。

The deployed selector uses the caller transaction SQL `now()` for freshness; it adds no lexical/top-K, label, split, same-Job or historical-time filter. Each unordered canonical pair is counted once, lower UUID to higher UUID. The current [quality-worker.ts](<../apps/scheduler/src/domains/project-finding-research/quality-worker.ts>) reuses this selector and the deployed identity comparison against actual current SQL sources; the offline lexical simulator remains a different evaluation path.

内部 trace 只记录本次有界机会：`peerIds` 是 UUID 升序的前256项，查询最多257项包含哨兵（本节2026-11-01 核对基线；上限归共用选择器的 `RELATION_PAIR_LIMIT`）。`observedCount` 包含哨兵，哨兵出现时 `truncated=true`、`countKind=lower_bound`，不是完整语料精确总数或排名；哨兵不进入比较，未进窗口不等于明确不同。无有效主体根因时不查询，空选择不等于人工负例或质量通过。trace 是内部工程结构，不是新增公开质量响应。

[选择器单元夹具](../apps/scheduler/src/domains/project-finding-research/strong-candidate-selector.test.ts) 验证不查询条件、SQL/参数原样性、边界与错误传播；[隔离 SQL 夹具](../apps/scheduler/src/domains/project-finding-research/strong-candidate-selector.integration.test.ts) 设计包含270 peers、两组 Job/Canvas 与不同 Job 状态、活跃重复 mapping、较小 UUID、外项目、过期、mapping/source 撤销、旧 revision、不同根因/字段及规范尾部对。它们只检验工程行为，不认证见证来源真实性、人工标签、独立分区或阈值，也不构成质量数据集。

Historical selector-only evidence (2026-11-01, schema66, before #831/schema67 integration): 2026-11-01 核对的本地已接线结果：`pnpm ci:unit:finding-research` 58通过、0跳过，包含新增选择器4项；`pnpm ci:integration:finding-research` 8个 SQL suite 全部因 `TEST_DATABASE_URL` 未设置而跳过，不是实际 SQL 通过。两入口已在[根脚本](../package.json) 纳入新测试，并由 [CI workflow](../.github/workflows/ci.yml) 的 unit / PostgreSQL integration 步骤调用；这不证明最终组合 SHA 的 Actions 已通过。选择器抽取只是后续实际 SQL 质量评估的共用前置条件，不补齐下述受治理软件与真实独立材料。 These counts are not acceptance of the new schema67 worker, receipts or API.

## #819 SQL quality engineering (2026-11-01, merged engineering slice)

The schema67 engineering baseline merged via #831 and passed at main commit `fdb55a01b1e02b5b9078586923a8d506ce5bb096`; the earlier schema65 SDK-only merge is historical, and formal publication remains incomplete. [quality-contract.ts](<../apps/scheduler/src/domains/project-finding-research/quality-contract.ts>), [quality-store.ts](<../apps/scheduler/src/domains/project-finding-research/quality-store.ts>) and [quality-ledger.ts](<../apps/scheduler/src/domains/project-finding-research/quality-ledger.ts>) define strict versioned protocol/scope commitments and registered, freeze, declaration, access, payload, admission, evaluation, review, revoke, rejection and alias-resolution receipts. Caller declarations cannot supply actor, server timestamps, pass flags or future report digests. The six quality tables, same-project foreign keys and append-only timestamps are detailed in [data architecture](<architecture/08-data-architecture.md>); resource ceilings link to source constants and are not quality/sample minima or reviewer quorum.

The management registrar in [quality-api.ts](<../apps/scheduler/src/domains/project-finding-research/quality-api.ts>) has nine protected routes; [interface semantics](<architecture/09-interface-specs.md>) explain true user-session authority, project ownership, strict inputs and report allowlisting. The payload route commits exposure in a separate preParsing transaction before JSON decoding, media/body-limit handling or admission. A later malformed/rejected body cannot erase exposure; a reused unknown-raw-body request key conflicts before body consumption, without creating another exposure. Project lifetime history includes revoked/expired protocols and alias receipts, under SQL row/byte limits; supplied-history completeness never certifies external absence of earlier access.

The [quality-worker.ts](<../apps/scheduler/src/domains/project-finding-research/quality-worker.ts>) appends one admitted holdout-subject observation per repeatable-read tick, with immutable generation/ordinal and deployed raw-SQL selection/comparison. A separate completion tick appends no new observation: it re-observes the full bounded cohort in one RR snapshot, checks current fingerprints and receipt order, recomputes metrics and binds the evaluation to actual work, dataset and run. Stored report reads also recompute in the caller RR snapshot; a report digest alone is not execution evidence. Review validates the durable chain, known principal conflicts and current stored report in that same snapshot, but neither `reviewed` nor `completed` is a quality-pass certificate.

Metrics in [quality-metrics.ts](<../apps/scheduler/src/domains/project-finding-research/quality-metrics.ts>) take per-class known truth from the entire admitted canonical holdout-pair universe: unselected or uncompared positive truth remains FN rather than shrinking recall denominators. Per-class precision/recall and candidate recall retain numerator/denominator; zero denominators are null. Null/insufficient labels, unknown selected pairs, missing traces/decisions, incomplete provenance/splits and truncation remain separate. Peers outside the admitted dataset stay visible in actual selection/unknown-label accounting; they are not silently filtered from traces or guessed as negative truth. Synthetic datasets remain blocked from independent quality acceptance.

Loaded assets in [quality-assets.ts](<../apps/scheduler/src/domains/project-finding-research/quality-assets.ts>) bind the actual Node load-returned evaluator-input bytes of the governed module graph. The Node24 synchronous [quality-source-capture.ts](<../apps/scheduler/src/domains/project-finding-research/quality-source-capture.ts>) preload is installed after TSX/other transforms and before governed imports; missing/late capture fails closed with no later disk-read fallback. Compiled JS and transformed TS intentionally bind their own bytes. Node, the loader chain and the preload are TCB: this is not self-certification, signed deployment integrity, successful evaluation or external human truth.

Verification entrypoints are `pnpm ci:unit:finding-quality` and `pnpm ci:integration:finding-quality`, alongside the unchanged Finding research/offline suites. The [root scripts](<../package.json>) name the unit and genuine PostgreSQL suites; the [CI workflow](<../.github/workflows/ci.yml>) invokes both, checks TEST_DATABASE_URL before integration and preloads direct compiled starts. Missing TEST_DATABASE_URL skips genuine SQL tests locally, not passes. [CI 41298113058](https://github.com/SummerSec/DeepSonar/actions/runs/41298113058) at main `fdb55a01b1e02b5b9078586923a8d506ce5bb096` passed the actual Finding research/quality unit and PostgreSQL/HTTP/worker suites and schema67 PGDMP backup, pg_restore and historical-baseline rebuild; #831's final PR and that main each passed 26 applicable checks across six workflows. #819 closed only for the agreed engineering slice. These are not independent human-quality results, current certificates or formal release proof. Subsequent #838 repair checks and final-main acceptance must stand on their own SHA; historical schema66/rebuild evidence remains historical. No suites, generators or validators run locally for this documentation change.

## 待审阅的验收建议（不是已批准阈值）

以下是可以在查看留出结果前评审的初始提案，不写入自动通过逻辑，也不追溯应用于已看过的留出结果：

| 项目 | 提案 | 边界 |
| --- | --- | --- |
| 检索候选 | 标注正例 recall@25 >= 0.90 | 只适用于事先确认覆盖范围的标注语料；必须同时给分母、截断和字段缺失分层结果 |
| Strong same-problem/root-cause suggestions | Proposed per-class precision >= 0.95 and recall >= 0.80 | Proposal only: not adopted thresholds; public suggestions remain suppressed and current-certificate/promotion software is missing |
| 信息不足 | 必须如实报告比例及分母，不单设越低越好的目标 | 不能为降低不足率而编造身份或把未知判为不同 |
| 硬边界 | 已知租户/服务等冲突不得输出同问题；不得传播 Verify/处置 | 来自原定行为约束，不是质量分数可抵消的错误 |

These proposed numbers are not empirically optimal or approved thresholds. Risk and independent review must determine adoption before holdout access; no fixed sample-count or reviewer-quorum requirement is invented. Small samples retain denominators and uncertainty. The #770 offline CLI still reports `not_evaluated` and cannot admit deployed receipts. The schema67 engineering protocol can freeze commitments and record accesses/reviews, but human-labeled/predeclared declarations, hashes and account IDs do not prove labels, natural-human independence, provenance, split isolation or pre-access threshold adoption; supplying them does not automatically produce passed quality.

## 最小外部输入与剩余工作

Remaining software: trusted host verification/admission of independent external evidence, natural-human alias/conflict resolution, an actual current certificate and audited CAS promotion with source/expiry/revocation invalidation, plus guarded nonempty public SQL/schema/read publication. The current protocol, exposure ledger, real-SQL observations, metrics, report reconstruction and structural review/revoke mechanisms are implemented engineering, not those missing gates. Remaining genuine inputs: permitted historical identity crosswalk/revisions; independent human labels and adjudication; verified asset/family-disjoint tuning/holdout; inspectable thresholds/protocol adopted and frozen before any holdout access, including prior/alias-corpus history. External authenticity and these independent facts remain UNVERIFIED. No production access, model call or model-cost experiment is required; non-model quality acceptance is not waived.

The #770 offline-tool historical slice left schema66, rules and scheduling unchanged. The agreed #819 quality engineering slice merged schema67 via #831 and passed actual rebuild/restore and SQL/HTTP/worker checks at fdb55a01 in Actions; this is an accepted main engineering baseline, not a completed formal release or independent quality acceptance. Public constants remain `published=false` / `not_evaluated`; no automatic disposition, grouping or knowledge promotion is added.


## 完整小规模积压与资源探针

`pnpm ci:probe:project-finding-backlog` 要求显式 `TEST_DATABASE_URL`，只连接管理库来创建唯一临时库；不会打开或修改 URL 指定的业务库。探针在临时库装载当前 baseline、运行真实候选 worker，最终删除自己的库。它不读取生产数据。单项目45来源，每条独立Job，混合重复热点声明、稀疏文本与缺字段；所有权威身份未知。首批后调用 enabled=false 停止回调，确认检查点不变再恢复。该步骤不是进程崩溃或真实维护 phase 切换测试，后两者不能由此推断。

初代实际完整发布后修改主体并新增1条来源，读取确认旧候选立即隐藏，再显式重建并完成46来源的新代。每批真实等待25ms，报告实际等待时间；生产循环等待2000ms、重扫延迟30秒，且还包含 feature worker，本探针不能外推线上吞吐。

本次单次共享开发环境测量：PostgreSQL16.15、Node24.19.0、OS可见 Xeon Platinum8573C/5逻辑CPU/18,882,662,400字节内存（不是数据库配额或峰值）。

| 阶段 | 实际完成来源 | 完整发布墙钟 | 实际批间等待 | 来源/墙钟秒 |
| --- | --- | --- | --- | --- |
| 初代 | 45 | 4.127s | 250.016ms | 10.903 |
| 修改+新增后重建 | 46 | 3.542s | 251.707ms | 12.985 |

首代积压45→40→…→5→0，随后一次空批才发布；第二代46→41→…→1→0并发布。观测覆盖每批检查点、状态、构建代/活动代、停止与恢复；不是从有限前缀推算全量完成。

场景总墙钟7.780秒。pg_stat_database 计数差：commit104、read blocks14、hit blocks193570、temp bytes0、deadlocks0；统计包含探针查询和 PostgreSQL 异步统计时序，不是精确磁盘IO吞吐。单worker连接请求统计flush，独立观察连接清快照，没有重置共享统计。track_io_timing 配置与原始前后值保留在报告中，关闭时的0不能证明没有IO耗时。

数据库分配字节13,171,735→14,574,095，候选四表含索引1,605,632字节，其中索引458,752字节，含保留旧代。连接数只是采样，不是峰值；未测数据库容器CPU/RSS或全cluster pg_stat_io。Node客户端 user/system CPU约2.581/0.472秒、进程生命周期maxRSS225,984KiB，不能当作PostgreSQL资源。完整样本与方法见[原始积压资源证据](evidence/770-backlog-probe.json)。这些是可复现工程观测，不是承诺容量或新添的上线阈值。

测试入口：`pnpm ci:unit:finding-offline-evaluation` 校验导入、隔离、缺标注、指标口径、CLI与统计；`pnpm ci:integration:finding-research` 运行独立库完整积压场景及原候选回归。真实人工质量评估尚未运行；本切片不因此无限追加可选优化。
## #819 evaluation boundary correction (2026-10-31)

Historical 2026-10-31 correction: Offline `authoritative_identity_mappings` remain synthetic, caller-declared replay inputs for evaluator behavior. They are not source-registry records, not independent external verification, and not evidence that the production mapping authority is trustworthy. The production registry is platform-admin admitted and explicitly reports that limitation. The default strong-relation quality gate remains `not_evaluated` and `published=false`. Genuine independent labels, family-and-asset-disjoint tuning/holdout and thresholds frozen before holdout inspection are necessary but not sufficient: governed evaluation/review admission, promotion/revocation and guarded public publication are still missing software paths. The agreed engineering accepted via #831 and the remaining deferred boundaries supersede the historical software-status sentence above; see the [2026-11-01 engineering summary](<PROJECT_FINDING_EVALUATION.md#819-sql-quality-engineering-2026-11-01-merged-engineering-slice>).

The registered Finding and Canvas read APIs also expose `authority_basis=platform_admin_attestation` and `independent_external_verification=false`; public `items` stay empty even when the disposable SQL fixture has successfully derived a relation. The HTTP integration test uses actual root authentication/project hooks, stored Management API Tokens, and a separately minted valid Job capability token; it verifies scopes, cross-project denial, source/mapping CAS, invalid input and publication suppression. These are engineering behavior checks, not external-source authentication, human-label independence, threshold approval, or measured relation quality. The existing Finding research unit/integration scripts include these tests and are called by the current CI workflow; no new quality-pass path is introduced.
