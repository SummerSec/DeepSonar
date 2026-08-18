import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { getSharedAssetBlobStore } from "./blob-store/index.js";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { drainInFlight, kickDispatcher, startDispatcher } from "./dispatcher.js";
import { startReaper } from "./reaper.js";
import { reconcileOnBoot } from "./reconcile.js";
import { registerRoutes } from "./routes.js";
import { startPlaneSync } from "./plane-sync.js";
import { startTransferWorker } from "./transfer/worker.js";
import {
  bootstrapOfficialRuntimeImages,
  startRuntimeImageRegistrySync,
} from "./runtime-images.js";
import { preheatManagedGateway } from "@deepsonar/runtime-sandbox";
import { startRuntimeImageWarmupOnBoot } from "./runtime-image-warmup.js";
import { startSkillSourceBootSync } from "./skill-sources.js";
import { dispatcherRuntimeStatus, markDispatcherEnabled } from "./startup-status.js";
import { normalizePendingJobPriorities } from "./core.js";
import { normalizePendingVerificationRounds } from "./verify.js";
import { ensureDefaultAdmin } from "./users.js";
import { refreshHostDiskPressure, startHostDiskMonitor } from "./host-disk.js";
import { startRuntimeImageGc } from "./runtime-image-gc.js";

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

  console.log("[boot] 校验 / 引导数据库 schema…");
  const applied = await migrate();
  if (applied.length > 0) console.log(`[boot] 已应用: ${applied.join(", ")}`);
  else console.log("[boot] schema 已就绪");
  const defaultAdmin = await ensureDefaultAdmin();
  if (defaultAdmin.created) console.log("[boot] 已创建默认管理员账号（首次登录后请立即修改账号与密码）");
  await bootstrapOfficialRuntimeImages();
  const managesLocalDocker = config.runtime.agentMode === "real" && config.runtime.provider === "local-docker";
  if (managesLocalDocker) await refreshHostDiskPressure();
  const stopSkillSourceBootSync = startSkillSourceBootSync();

  const app = Fastify({
    logger: { level: "info" },
    trustProxy: config.http.trustProxyHops > 0 ? config.http.trustProxyHops : false,
  });
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

  let stopDispatcher = () => {};
  let stopRuntimeImageWarmup = () => {};
  const stopReaper = startReaper();
  const stopPlane = startPlaneSync();
  const stopTransfer = startTransferWorker();
  const stopRuntimeImageRegistrySync = startRuntimeImageRegistrySync();
  const stopRuntimeImageGc = startRuntimeImageGc();
  const stopHostDiskMonitor = managesLocalDocker
    ? startHostDiskMonitor(() => {
        if (dispatcherRuntimeStatus().enabled) kickDispatcher();
      })
    : () => {};

  const shutdown = async () => {
    stopDispatcher();
    markDispatcherEnabled(false);
    stopRuntimeImageWarmup();
    stopReaper();
    stopPlane();
    stopTransfer();
    stopRuntimeImageRegistrySync();
    stopRuntimeImageGc();
    stopHostDiskMonitor();
    stopSkillSourceBootSync();
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
  stopRuntimeImageWarmup = startRuntimeImageWarmupOnBoot(() => {
    stopDispatcher = startDispatcher();
    markDispatcherEnabled(true);
    console.log("[runtime-images] startup image set ready; dispatcher enabled");
  }, {
    afterPrepare: async (refs) => {
      if (config.runtime.agentMode === "fake" || config.runtime.provider !== "local-docker") return;
      const base = refs.find((item) => item.image_key === "deepsonar-base") ?? refs[0];
      if (!base) return;
      await preheatManagedGateway({
        upstreamUrl: config.gateway.proxyUpstreamUrl,
        image: base.image_ref,
        createTimeoutMs: config.gateway.createTimeoutSec * 1000,
      });
    },
  });
}

main().catch((e) => {
  console.error("[boot] 启动失败:", e);
  process.exit(1);
});
