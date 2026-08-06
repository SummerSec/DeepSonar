import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { getSharedAssetBlobStore } from "./blob-store/index.js";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { drainInFlight, startDispatcher } from "./dispatcher.js";
import { startReaper } from "./reaper.js";
import { reconcileOnBoot } from "./reconcile.js";
import { registerRoutes } from "./routes.js";
import { startPlaneSync } from "./plane-sync.js";
import { startTransferWorker } from "./transfer/worker.js";
import { bootstrapOfficialRuntimeImages, startRuntimeImageRegistrySync } from "./runtime-images.js";
import { bootstrapSkillSourcesOnBoot } from "./skill-sources.js";
import { normalizePendingJobPriorities } from "./core.js";
import { normalizePendingVerificationRounds } from "./verify.js";
import { ensureDefaultAdmin } from "./users.js";

async function main() {
  // agentbox-sdk 内部个别异步错误会以 unhandledRejection 冒出（如 daemon 启动失败），
  // 绝不能因此崩掉整个调度进程 —— 记日志即可，job 级错误由 runJob 的 try/catch 兜底
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal-guard] unhandledRejection:", reason instanceof Error ? reason.message : reason);
  });

  // Fail fast on invalid BLOB_STORE / missing S3 bucket (shared-asset CAS only).
  const sharedAssetBlobs = getSharedAssetBlobStore();
  console.log(
    sharedAssetBlobs.kind === "s3"
      ? `[boot] shared-asset BlobStore=s3 bucket=${config.storage.s3.bucket} endpoint=${config.storage.s3.endpoint || "(default AWS)"}`
      : `[boot] shared-asset BlobStore=fs root=${config.storage.blobDir}`,
  );

  console.log("[boot] 应用数据库 schema / 迁移…");
  const applied = await migrate();
  if (applied.length > 0) console.log(`[boot] 已应用: ${applied.join(", ")}`);
  else console.log("[boot] schema 已就绪（无需变更）");
  const defaultAdmin = await ensureDefaultAdmin();
  if (defaultAdmin.created) console.log("[boot] 已创建默认管理员账号（首次登录后请立即修改账号与密码）");
  await bootstrapOfficialRuntimeImages();
  await bootstrapSkillSourcesOnBoot();

  const app = Fastify({ logger: { level: "info" } });
  await app.register(websocket);
  registerRoutes(app);

  // 重启 reconcile（JOB-04）：先对齐 DB↔docker，再放行调度
  await reconcileOnBoot();
  const normalizedRounds = await normalizePendingVerificationRounds();
  if (normalizedRounds.missingJobReclassified > 0 || normalizedRounds.staleJobRepaired > 0) {
    console.warn(
      `[boot] normalized verification rounds: missing=${normalizedRounds.missingJobReclassified}/${normalizedRounds.missingJobExamined}, ` +
        `stale=${normalizedRounds.staleJobRepaired}/${normalizedRounds.staleJobExamined}`,
    );
  }
  const normalizedPriorities = await normalizePendingJobPriorities();
  if (normalizedPriorities.updated > 0) {
    console.warn(`[boot] normalized ${normalizedPriorities.updated}/${normalizedPriorities.examined} pending Job priorities`);
  }

  const stopDispatcher = startDispatcher();
  const stopReaper = startReaper();
  const stopPlane = startPlaneSync();
  const stopTransfer = startTransferWorker();
  const stopRuntimeImageRegistrySync = startRuntimeImageRegistrySync();

  const shutdown = async () => {
    stopDispatcher();
    stopReaper();
    stopPlane();
    stopTransfer();
    stopRuntimeImageRegistrySync();
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
