import type { FastifyInstance } from "fastify";
import { authHook } from "./auth.js";
import { registerGateway } from "./gateway.js";
import { projectScopeHook } from "./project-scope-hook.js";
import { registerApiTokenRoutes } from "./domains/api-token/routes.js";
import { registerAuditRoutes } from "./domains/audit/routes.js";
import { registerAuthRoutes } from "./domains/auth/routes.js";
import { registerCanvasRoutes } from "./domains/canvas/routes.js";
import { registerDashboardRoutes } from "./domains/dashboard/routes.js";
import { registerCredentialRoutes } from "./domains/credential/routes.js";
import { registerFindingResearchRoutes } from "./domains/finding-research/index.js";
import { registerFindingVerificationRoutes } from "./domains/finding-verification/routes.js";
import { registerJobControlRoutes } from "./domains/job-control/routes.js";
import { registerProjectTaskRoutes } from "./domains/project-task/routes.js";
import { registerReportRoutes } from "./domains/report-convergence/routes.js";
import { registerRoleConfigRoutes } from "./domains/role-config/routes.js";
import { registerRuntimeImageRoutes } from "./domains/runtime-image/routes.js";
import { registerSettingsRoutes } from "./domains/settings/routes.js";
import { registerSharedAssetRoutes } from "./domains/shared-assets/routes.js";
import { registerSkillSourceRoutes } from "./domains/skill-source/routes.js";
import { registerStreamRoutes } from "./domains/stream/routes.js";
import { registerSystemRoutes } from "./domains/system/routes.js";
import { registerWorkerNodeRoutes } from "./domains/worker-nodes/index.js";
import { registerTransferRoutes } from "./domains/transfer/routes.js";
import { registerPlatformControlRoutes } from "./domains/platform-api/routes.js";
import { runtimeImageHttpError } from "./runtime-images.js";

export function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _req, reply) => {
    const mapped = runtimeImageHttpError(error);
    if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
    return reply.send(error);
  });
  // 平台 API Token 鉴权（SEC-01）：DEEPSONAR_AUTH_REQUIRED=true 时生效；/health 豁免
  app.addHook("onRequest", authHook);
  app.addHook("preHandler", projectScopeHook);

  // Report convergence is a bounded route registrar. Shared auth and project
  // scope hooks above are installed before it, preserving legacy behavior.
  registerReportRoutes(app);
  registerFindingVerificationRoutes(app);
  registerFindingResearchRoutes(app);
  registerSharedAssetRoutes(app);

  // Model Gateway（§6.3）：自身用 DEEPSONAR_JOB_TOKEN 鉴权（authHook 豁免 /gateway/*）
  registerGateway(app);

  // Job-scoped Platform Tool API. Its routes are exempt from the platform
  // authHook because they perform their own independent capability-token
  // authentication and never accept a management API token.
  registerPlatformControlRoutes(app);

  registerAuthRoutes(app);

  registerStreamRoutes(app);

  registerProjectTaskRoutes(app);
  registerDashboardRoutes(app);
  registerSkillSourceRoutes(app);
  registerRuntimeImageRoutes(app);

  registerRoleConfigRoutes(app);

  registerSettingsRoutes(app);

  registerCanvasRoutes(app);

  registerJobControlRoutes(app);

  registerApiTokenRoutes(app);

  registerCredentialRoutes(app);

  registerAuditRoutes(app);
  registerTransferRoutes(app);
  registerSystemRoutes(app);
  registerWorkerNodeRoutes(app);
}
