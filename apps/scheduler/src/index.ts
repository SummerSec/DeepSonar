import { createPlatformMaintenanceGate, registerPlatformMaintenanceGuard, type PlatformUpgradeState } from "./platform-maintenance.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { getSharedAssetBlobStore } from "./blob-store/index.js";
import { config, managesHostDockerRuntime } from "./config.js";
import { migrate, sql, SCHEMA_VERSION } from "./db.js";
import { drainInFlight, kickDispatcher, startDispatcher } from "./dispatcher.js";
import { startReaper } from "./reaper.js";
import { reconcileOnBoot } from "./reconcile.js";
import { registerRoutes } from "./routes.js";
import { startTransferWorker } from "./transfer/worker.js";
import {
  bootstrapOfficialRuntimeImages,
  reconcileRuntimeImagePullTasksOnBoot,
  startRuntimeImageRegistrySync,
} from "./runtime-images.js";
import { useSqlRuntimeImagePullTaskStore } from "./runtime-image-pull-status.js";
import {
  GATEWAY_UPSTREAM_SOCKET_NAME,
  gatewayUpstreamSocketFromEnv,
  preheatManagedGateway,
} from "@deepsonar/runtime-sandbox";
import { relayTargetHost, startGatewayUpstreamSocket } from "./gateway-upstream-socket.js";
import { startRuntimeImageWarmupOnBoot, prepareRuntimeImageWarmupForMaintenance } from "./runtime-image-warmup.js";
import { startSkillSourceBootSync } from "./skill-sources.js";
import { dispatcherRuntimeStatus, markDispatcherEnabled } from "./startup-status.js";
import { normalizePendingJobPriorities, scrubLeftoverStoredRules, scrubRedundantConfigSurface } from "./core.js";
import { scrubIgnoredProjectRoleConfigIdentity } from "./domains/role-runtime-snapshot/index.js";
import { normalizePendingVerificationRounds } from "./verify.js";
import { ensureDefaultAdmin } from "./users.js";
import { refreshHostDiskPressure, startHostDiskMonitor } from "./host-disk.js";
import { startRuntimeImageGc } from "./runtime-image-gc.js";
import { seedLocalWorkerNode } from "./domains/worker-nodes/index.js";

async function main() {
  // 运行时 SDK 内部个别异步错误会以 unhandledRejection 冒出（如 daemon 启动失败），
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
  else   console.log("[boot] schema 已就绪");
  const identity = {
    generation: process.env.DEEPSONAR_UPGRADE_GENERATION ?? "",
    version: process.env.DEEPSONAR_VERSION ?? "",
  };
  let stopRuntimeImageWarmup = () => {};
  let stopGatewayUpstreamSocket: () => Promise<void> = async () => {};
  const maintenance = createPlatformMaintenanceGate({
    identity,
    readState: async () => {
      const [state] = await sql`
        SELECT phase, generation, runtime_role, target_version, CURRENT_USER AS current_role,
               (SELECT version FROM schema_meta WHERE id = 'global') AS schema_version
        FROM platform_upgrade_state WHERE id = 'global'`;
      if (!state || Number(state.schema_version) !== SCHEMA_VERSION) return null;
      return state as unknown as PlatformUpgradeState;
    },
    onClose: () => {
      markDispatcherEnabled(false);
      if (!maintenance.identityMatches()) stopRuntimeImageWarmup();
    },
    start: (registerStop) => {
      registerStop(startSkillSourceBootSync());
      registerStop(startReaper());
      registerStop(startTransferWorker());
      registerStop(startRuntimeImageRegistrySync());
      registerStop(startRuntimeImageGc());
      registerStop(managesHostDockerRuntime() ? startHostDiskMonitor(() => {
        if (dispatcherRuntimeStatus().enabled) kickDispatcher();
      }) : () => {});
      registerStop(startDispatcher());
      markDispatcherEnabled(true);
    },
  });
  await maintenance.refresh();
  if (!maintenance.identityMatches()) throw new Error("platform upgrade state does not authorize this runtime");
  const localWorker = await seedLocalWorkerNode();
  if (localWorker) {
    console.log(`[boot] execution-plane local worker ${localWorker.id} @ ${localWorker.endpoint}`);
  }
  const defaultAdmin = await ensureDefaultAdmin();
  if (defaultAdmin.created) console.log("[boot] 已创建默认管理员账号（首次登录后请立即修改账号与密码）");
  const scrubbed = await scrubIgnoredProjectRoleConfigIdentity(sql);
  if (scrubbed.runtime_image_keys > 0 || scrubbed.inherit_global_models > 0) {
    console.warn(
      `[boot] scrubbed leftover project RoleConfig identity: images=${scrubbed.runtime_image_keys}, inherit_global_models=${scrubbed.inherit_global_models}`,
    );
  }
  const scrubbedRules = await scrubLeftoverStoredRules(sql);
  if (scrubbedRules.global > 0 || scrubbedRules.projects > 0) {
    console.warn(
      `[boot] scrubbed leftover rules_json keys: global=${scrubbedRules.global}, projects=${scrubbedRules.projects}`,
    );
  }
  const scrubbedConfig = await scrubRedundantConfigSurface(sql);
  if (scrubbedConfig.protocols > 0 || scrubbedConfig.imagePolicies > 0 || scrubbedConfig.roleKnobs > 0) {
    console.warn(
      `[boot] scrubbed redundant config surface: protocols=${scrubbedConfig.protocols}, imagePolicies=${scrubbedConfig.imagePolicies}, roleKnobs=${scrubbedConfig.roleKnobs}`,
    );
  }
  useSqlRuntimeImagePullTaskStore();
  await reconcileRuntimeImagePullTasksOnBoot();
  await bootstrapOfficialRuntimeImages();
  if (managesHostDockerRuntime()) await refreshHostDiskPressure();

  const app = Fastify({
    logger: { level: "info" },
    trustProxy: config.http.trustProxyHops > 0 ? config.http.trustProxyHops : false,
  });
  registerPlatformMaintenanceGuard(app, maintenance, identity.version);
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

  const maintenanceTimer = setInterval(() => void maintenance.refresh(), 1_000);
  maintenanceTimer.unref();

  const shutdown = async () => {
    clearInterval(maintenanceTimer);
    maintenance.close();
    await stopGatewayUpstreamSocket().catch(() => {});
    stopRuntimeImageWarmup();
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
  // #685: bridge deploys keep Scheduler off sandbox networks; the managed proxy
  // reaches it through this socket on a shared volume instead of DNS.
  try {
    const upstreamSocket = gatewayUpstreamSocketFromEnv();
    if (upstreamSocket) {
      const relay = await startGatewayUpstreamSocket({
        dir: upstreamSocket.dir,
        socketName: GATEWAY_UPSTREAM_SOCKET_NAME,
        targetHost: relayTargetHost(config.host),
        targetPort: config.port,
      });
      stopGatewayUpstreamSocket = relay.close;
      console.log(`[gateway-upstream] proxy upstream socket ready: ${relay.path} (volume ${upstreamSocket.volume})`);
    }
  } catch (error) {
    console.error("[gateway-upstream] 无法创建 proxy 上游 socket，沙箱 Gateway/Control API 将不可达:", error);
    if (identity.generation) throw error;
  }
  const afterPrepare = async (refs: Array<{ image_ref: string; image_key?: string }>) => {
    if (config.runtime.agentMode === "fake" || config.runtime.provider !== "opensandbox") return;
    const base = refs.find((item) => item.image_key === "deepsonar-base") ?? refs[0];
    if (!base) return;
    await preheatManagedGateway({
      upstreamUrl: config.gateway.proxyUpstreamUrl,
      image: base.image_ref,
      createTimeoutMs: config.gateway.createTimeoutSec * 1000,
    });
  };
  const bootReady = () => {
    maintenance.setBootReady();
    void maintenance.refresh();
  };
  if (identity.generation) {
    await prepareRuntimeImageWarmupForMaintenance(afterPrepare);
    bootReady();
  } else {
    // Preserve ordinary startup retries; the dispatcher still starts only after
    // warmup and a fresh successful DB authorization read.
    stopRuntimeImageWarmup = startRuntimeImageWarmupOnBoot(bootReady, { afterPrepare });
  }
}

main().catch((e) => {
  console.error("[boot] 启动失败:", e);
  process.exit(1);
});
