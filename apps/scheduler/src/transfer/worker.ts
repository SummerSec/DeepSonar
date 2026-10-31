/**
 * Transfer Worker：处理 pending export / 不跑 Agent
 */
import { sql } from "../db.js";
import { runExport } from "./export.js";
import { runPlatformExport } from "./platform.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function processExportRow(id: string, scope?: string): Promise<void> {
  const [row] = await sql`SELECT id, scope FROM data_exports WHERE id = ${id}`;
  if (!row) return;
  if ((row.scope as string) === "platform" || scope === "platform") {
    await runPlatformExport(id);
  } else {
    await runExport(id);
  }
}

export function startTransferWorker(): () => void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const pending = await sql`
        SELECT id, scope FROM data_exports
        WHERE status = 'pending'
        ORDER BY created_at ASC LIMIT 3`;
      for (const row of pending) {
        await processExportRow(row.id as string, row.scope as string);
      }
    } catch (e) {
      console.error("[transfer] worker error:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(() => void tick(), 2000);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
