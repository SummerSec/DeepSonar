import { PublishSharedAssetPayload } from "@deepsonar/shared-types";
import { config } from "./config.js";
import { ControlInputError, controlInputCodeForOperation } from "./control-input.js";
import { sql } from "./db.js";
import { createSharedAsset } from "./domains/shared-assets/index.js";
import { controlInputDigest } from "./domains/event-ingestion/control-receipt.js";
import { PlatformRuntimeHandlerError } from "./domains/platform-api/registry.js";

type PublishedIdentity = { asset: { id: string }; version: { id: string; content_sha256: string } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reject(code: string, message: string) {
  return new PlatformRuntimeHandlerError("OPERATION_REJECTED", message,
    { statusCode: 409, errorCode: code, retryable: false });
}

function unknownPublication() {
  return new PlatformRuntimeHandlerError("OPERATION_REJECTED", "共享资产发布结果未知，禁止自动重放。", {
    statusCode: 409, errorCode: "SHARED_ASSET_PUBLISH_UNKNOWN", retryable: false,
    category: "unknown_external_effect",
    next_action: "停止发布；核对原请求与已持久化资产版本，不能换 key 自动重放。",
  });
}

/**
 * One publisher per live executor/Attempt. HTTP's cache drops opaque failures;
 * retain the original promise here, including unknown outcomes, so a transport
 * retry cannot re-read changed source bytes and create another version.
 * This is NOT a durable receipt or a restart/recovery execution path.
 */
export function createSharedAssetPublisher(scope: {
  jobId: string; attemptId: string; projectId: string; sandboxId: string | null; findingId: string | null;
  assertCanPublish: (jobId: string, sandboxId: string | null) => Promise<void>;
  sourceReadError: (error: unknown) => ControlInputError;
  classifyError: (error: unknown) => ControlInputError | null;
}) {
  const invocations = new Map<string, { digest: string; result: Promise<PublishedIdentity> }>();
  const assertCurrent = async () => {
    await scope.assertCanPublish(scope.jobId, scope.sandboxId);
    const [attempt] = await sql`
      SELECT a.id FROM job_attempts a JOIN jobs j ON j.id=a.job_id
      WHERE a.id=${scope.attemptId} AND a.job_id=${scope.jobId} AND j.sandbox_id=${scope.sandboxId}
        AND a.status='active' AND a.cancel_requested=false
        AND j.status='running' AND j.lease_expires_at > now()`;
    if (!attempt) throw reject("SHARED_ASSET_PUBLISH_ATTEMPT_CHANGED", "当前发布执行已失效，停止提交。");
  };
  return async (input: unknown, key: string | null | undefined,
    read: (path: string, maxBytes: number) => Promise<Buffer>): Promise<PublishedIdentity> => {
    const proposal = PublishSharedAssetPayload.parse(input);
    if (!key || !UUID.test(key)) throw reject("IDEMPOTENCY_KEY_REQUIRED", "发布必须携带 UUID Idempotency-Key。");
    if (proposal.scope === "finding" && !scope.findingId) {
      throw new ControlInputError(controlInputCodeForOperation("publish_shared_asset"),
        "本 Job 未绑定 Finding，不能发布 Finding 资产", "scope");
    }
    await assertCurrent(); // Cached responses do not grant stale executors authority.
    const digest = controlInputDigest(proposal);
    const previous = invocations.get(key);
    if (previous) {
      if (previous.digest !== digest) throw reject("IDEMPOTENCY_KEY_CONFLICT", "同一 key 已用于不同的发布参数。");
      return previous.result;
    }
    const result = Promise.resolve().then(async (): Promise<PublishedIdentity> => {
      let bytes: Buffer;
      try { bytes = await read(proposal.source_path, config.sharedAssets.maxFileBytes); }
      catch (error) { throw scope.sourceReadError(error); }
      await assertCurrent();
      try {
        const created = await createSharedAsset({
          scope: proposal.scope, projectId: scope.projectId,
          findingId: proposal.scope === "finding" ? scope.findingId : null,
          key: proposal.key, contentType: proposal.content_type, bytes, origin: "agent",
          actor: `job:${scope.jobId}`, jobId: scope.jobId, labels: proposal.labels,
        });
        // Whitelist actual persistence fields. Neither numeric current_version
        // nor the operation event UUID can stand in for a version row's UUID.
        const { id, version_id, content_sha256 } = created;
        if (typeof id !== "string" || !UUID.test(id) || typeof version_id !== "string" || !UUID.test(version_id)
          || typeof content_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(content_sha256)) throw unknownPublication();
        return { asset: { id }, version: { id: version_id, content_sha256 } };
      } catch (error) {
        if (error instanceof PlatformRuntimeHandlerError || error instanceof ControlInputError) throw error;
        const known = scope.classifyError(error);
        if (known) throw known;
        // A thrown persistence call does not establish rollback/no effect.
        throw unknownPublication();
      }
    });
    // Reserve before yielding; concurrent invocations share the entire operation.
    invocations.set(key, { digest, result });
    return result;
  };
}
