import Fastify from "fastify";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { startDispatcher } from "./dispatcher.js";
import { startReaper } from "./reaper.js";
import { registerRoutes } from "./routes.js";
import { startPlaneSync } from "./plane-sync.js";

async function main() {
  console.log("[boot] 运行数据库迁移…");
  const applied = await migrate();
  if (applied.length > 0) console.log(`[boot] 已应用迁移: ${applied.join(", ")}`);

  const app = Fastify({ logger: { level: "info" } });
  registerRoutes(app);

  const stopDispatcher = startDispatcher();
  const stopReaper = startReaper();
  const stopPlane = startPlaneSync();

  const shutdown = async () => {
    stopDispatcher();
    stopReaper();
    stopPlane();
    await app.close();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[boot] scheduler 已启动: http://localhost:${config.port}`);
}

main().catch((e) => {
  console.error("[boot] 启动失败:", e);
  process.exit(1);
});
