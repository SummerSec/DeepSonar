/** 画布增量通知冒烟：验证 PostgreSQL NOTIFY → 实时回查 → 会话消息回调。 */
import { randomUUID } from "node:crypto";
import { subscribeCanvasUpdates } from "../apps/scheduler/src/canvas-updates.js";
import { sql } from "../apps/scheduler/src/db.js";

const projectId = randomUUID();
const canvasId = randomUUID();
let unsubscribe: (() => void) | undefined;

try {
  await sql`
    INSERT INTO projects (id, canvas_id, name, description)
    VALUES (${projectId}, ${randomUUID()}, '__deepsonar_canvas_update_smoke__', 'temporary smoke')`;
  await sql`
    INSERT INTO canvases (id, project_id, title, target_json)
    VALUES (${canvasId}, ${projectId}, 'canvas update smoke', ${{ network_policy: { allow_egress: false } } as never})`;

  let resolveMessage!: (message: string) => void;
  const messageReceived = new Promise<string>((resolve) => {
    resolveMessage = resolve;
  });
  unsubscribe = await subscribeCanvasUpdates(canvasId, "listener-job", async (message) => {
    resolveMessage(message);
  });

  await sql`
    INSERT INTO canvas_nodes (canvas_id, node_type, title, body_json, status)
    VALUES (${canvasId}, 'fact', '增量事实', ${{ description: "来自其他 Worker 的证据" } as never}, 'open')`;

  const message = await Promise.race([
    messageReceived,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("canvas update timeout")), 5_000)),
  ]);
  if (!message.includes("增量事实") || !message.includes("来自其他 Worker 的证据")) {
    throw new Error(`unexpected message: ${message}`);
  }
  console.log(JSON.stringify({ delivered: true, via: "deepsonar_canvas_events", contains_fact: true }));
} finally {
  unsubscribe?.();
  await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`.catch(() => {});
  await sql`DELETE FROM canvases WHERE id = ${canvasId}`.catch(() => {});
  await sql`DELETE FROM projects WHERE id = ${projectId}`.catch(() => {});
  await sql.end({ timeout: 1 });
}
