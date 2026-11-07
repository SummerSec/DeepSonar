# 集成测试共享连接池 teardown 待办清单（issue #971）

`apps/scheduler/src/db.ts` 导出模块级共享单例 `sql`，`config.db.idleTimeoutSec` 默认 30 秒。
teardown 未显式 `sql.end({ timeout: 5 })` 时，node:test 进程尾部会多等约一个 idle 周期。
本轮只处理三次 gate 样本命中的 3 个套件；生产 `config.ts` 的 idle timeout 保持不变，
不使用 `process.exit` / 强制退出，也不用 `.catch(() => {})` 吞掉关闭错误（清理失败必须可见）。
契约回归：`apps/scheduler/src/integration-pool-teardown.test.mjs`。

## 本轮已按范式处理（3 个）

在 `finally` 最末尾、数据清理与 `app.close()` 之后调用 `sql.end({ timeout: 5 })`；
`export` 无 Fastify 实例，直接在 `finally` 末尾关闭。

- `apps/scheduler/src/domains/dashboard/overview.integration.test.ts`
- `apps/scheduler/src/domains/dashboard/quality.integration.test.ts`
- `apps/scheduler/src/transfer/export.integration.test.ts`

## 其余长尾套件

静态核对：改前「使用共享 `sql` 且无 `sql.end`」的 `*.integration.test.ts` 共 21 个，
即上节 3 个加下列 18 个。下列 18 个**未在本轮批量修改，需逐个受控验证**：

- `apps/scheduler/src/domains/dashboard/ops.integration.test.ts`
- `apps/scheduler/src/domains/event-ingestion/plan-protocol.integration.test.ts`
- `apps/scheduler/src/domains/job-attempt/recovery.integration.test.ts`
- `apps/scheduler/src/domains/platform-api/completion-crash.integration.test.ts`
- `apps/scheduler/src/domains/project-knowledge/choice-evidence-export.integration.test.ts`
- `apps/scheduler/src/domains/worker-nodes/registry.integration.test.ts`
- `apps/scheduler/src/import-resume.integration.test.ts`
- `apps/scheduler/src/plan-bootstrap.integration.test.ts`
- `apps/scheduler/src/plan-decision.integration.test.ts`
- `apps/scheduler/src/plan-execution.integration.test.ts`
- `apps/scheduler/src/plan-replay-v2.integration.test.ts`
- `apps/scheduler/src/plan-revision.integration.test.ts`
- `apps/scheduler/src/platform-upgrade-knowledge.integration.test.ts`
- `apps/scheduler/src/project-reports.integration.test.ts`
- `apps/scheduler/src/runtime-images-channel.integration.test.ts`
- `apps/scheduler/src/runtime-images-promotions.integration.test.ts`
- `apps/scheduler/src/session-memory.integration.test.ts`
- `apps/scheduler/src/shared-asset-lifecycle.integration.test.ts`

清单以工作树 `rg` 复核为准。

## 逐个核对的顺序

1. 先按所属 gate 脚本分堆：`ci:integration:dashboard-overview`、`ci:integration:transfer-export`
   等脚本决定一次 `tsx --test` 调用包含哪些文件、是否带 `--test-concurrency=1`。
2. 每堆内先处理「单文件、无后台任务、无在途查询」的低风险套件，再处理多文件同调用、
   带后台任务 / 定时器 / worker 的套件。
3. 对每个文件固定按以下顺序核对：
   1. 是否有后台任务、定时器、worker 或未 await 的异步查询；
   2. 是否与同脚本其它文件共享进程：`node --test` 默认每文件独立子进程，模块级 `sql`
      单例通常不跨文件共享；但 `--import` 预加载 / 自定义 loader、或单文件内多个 `test()`
      共享单例时，先 `sql.end()` 的文件会让后跑用例拿到已关闭的池，必须实测确认；
   3. `--test-concurrency=1` 只把并发度降为串行，不改变「每文件独立进程」，但会让同一次调用里
      多个文件的尾部等待累加，因此同调用内每个文件都要各自关池；
   4. 关池前先等在途 HTTP 请求 / 查询 / 后台任务结束，顺序为：清理数据 → `app.close()` →
      等待在途任务 → `sql.end({ timeout: 5 })`；
   5. 再套用范式，单独跑对应 gate 脚本计时确认尾部不再等待一个 idle 周期。
4. 每改一个文件单独验证、确认无「池已关闭」类回归后再推进下一个，不做机械批量替换。

## 约束

- 不改生产 `config.ts` 的 `idleTimeoutSec`；
- 不在 `afterEach` 或单个 `test()` 里关池（同文件其它用例还要复用共享单例）；
- 脚本名与路径以根 `package.json` 和工作树实际文件为准。
