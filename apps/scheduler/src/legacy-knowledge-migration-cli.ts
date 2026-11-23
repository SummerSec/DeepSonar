/**
 * 历史任务沉淀并回知识库（#1219 第一步的补齐动作）。
 *
 *   pnpm --filter @deepsonar/scheduler exec tsx src/legacy-knowledge-migration-cli.ts --plan
 *   pnpm --filter @deepsonar/scheduler exec tsx src/legacy-knowledge-migration-cli.ts --apply --limit 50
 *
 * 只按回执回放：正文来自内容寻址存储，归属仍是当初的 Job / Attempt / 画布，
 * 因此不会把旧记录写成新任务的成果。`--apply` 每份回执一个事务，成功后写回 ingested
 * 标记，重复执行会跳过；入库本身另有内容哈希幂等。
 */
import { sql } from "./db.js";
import { migrateLegacyKnowledge } from "./legacy-knowledge-migration.js";

export async function runLegacyKnowledgeMigration(db: unknown, argv: string[]) {
  const apply = argv.includes("--apply");
  const limitArg = argv[argv.indexOf("--limit") + 1];
  const limit = argv.includes("--limit") && Number.isFinite(Number(limitArg)) ? Number(limitArg) : 50;
  const result = await migrateLegacyKnowledge(db, { apply, limit });
  return { mode: apply ? "apply" : "plan" as const, ...result };
}

if (process.argv[1]?.endsWith("legacy-knowledge-migration-cli.ts")) {
  const report = await runLegacyKnowledgeMigration(sql, process.argv.slice(2));
  for (const candidate of report.candidates) {
    console.log(`${candidate.receipt_id} job=${candidate.job_id} canvas=${candidate.canvas_id ?? "-"} items=${candidate.item_count ?? "?"}`);
  }
  for (const outcome of report.outcomes) {
    console.log(`${outcome.receipt_id} ${outcome.error ? `FAILED ${outcome.error}`
      : outcome.items.map((item) => `${item.outcome}:${item.logical_key}`).join(",") || "skipped"}`);
  }
  console.log(`mode=${report.mode} scanned=${report.totals.scanned} migrated=${report.totals.migrated} `
    + `unchanged=${report.totals.unchanged} skipped=${report.totals.skipped} failed=${report.totals.failed}`);
  await sql.end();
}
