import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { drainInFlight, startDispatcher } from "./dispatcher.js";
import { startReaper } from "./reaper.js";
import { reconcileOnBoot } from "./reconcile.js";
import { registerRoutes } from "./routes.js";
import { startPlaneSync } from "./plane-sync.js";

async function main() {
  // agentbox-sdk 内部个别异步错误会以 unhandledRejection 冒出（如 daemon 启动失败），
  // 绝不能因此崩掉整个调度进程 —— 记日志即可，job 级错误由 runJob 的 try/catch 兜底
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal-guard] unhandledRejection:", reason instanceof Error ? reason.message : reason);
  });

  console.log("[boot] 运行数据库迁移…");
  const applied = await migrate();
  if (applied.length > 0) console.log(`[boot] 已应用迁移: ${applied.join(", ")}`);

  const app = Fastify({ logger: { level: "info" } });
  await app.register(websocket);
  registerRoutes(app);

  // 重启 reconcile（JOB-04）：先对齐 DB↔docker，再放行调度
  await reconcileOnBoot();

  const stopDispatcher = startDispatcher();
  const stopReaper = startReaper();
  const stopPlane = startPlaneSync();

  const shutdown = async () => {
    stopDispatcher();
    stopReaper();
    stopPlane();
    // 优雅退出（§12.2）：先等在执行的 job 收尾，再关 HTTP 与 DB
    await drainInFlight(15_000);
    await app.close();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[boot] scheduler 已启动: http://${config.host}:${config.port}`);
}

main().catch((e) => {
  console.error("[boot] 启动失败:", e);
  process.exit(1);
});
