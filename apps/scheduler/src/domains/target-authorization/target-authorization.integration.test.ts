import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeTaskContract } from "@deepsonar/shared-types";
import {
  REFERENCE_TARGET_ACTIONS,
  TargetAuthorizationSnapshot,
  createTargetAuthorizationConfig,
  type TargetAuthorizationResponse,
} from "./index.js";
import { executeReferenceTargetFixture, TARGET_FIXTURE_CREDENTIAL } from "./target-client.fixture.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("trusted target authorization SQL/HTTP fixture requires TEST_DATABASE_URL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("trusted target authorization executes the real task, Control, child and test-only Worker chain", async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_target_auth_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let server: Server | undefined;
    let endSql: (() => Promise<unknown>) | undefined;
    let closeApp: (() => Promise<unknown>) | undefined;
    let drainDispatcher: (() => Promise<void>) | undefined;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), "target-authorization-"));
    const registeredRuntimeHandlers: string[] = [];
    const fixture = {
      revoked: false,
      prerequisiteUnavailable: false,
      malformed: false,
      authorityRevision: "policy-1",
      scopeOverride: {} as Partial<TargetAuthorizationResponse["scope"]>,
      requests: [] as Array<Record<string, unknown>>,
      targetRequests: [] as Array<Record<string, unknown>>,
      targetPaths: [] as string[],
      targetState: "empty",
      secret: "target-auth-fixture-value",
      principalId: undefined as string | undefined,
    };
    const environmentKeys = [
      "DATABASE_URL",
      "AGENT_MODE",
      "DEEPSONAR_AUTH_REQUIRED",
      "DEEPSONAR_MASTER_KEY",
      "BLOB_DIR",
      "DEEPSONAR_TARGET_AUTHORITY_URL",
      "DEEPSONAR_TARGET_AUTHORITY_ID",
      "DEEPSONAR_TARGET_AUTHORITY_SECRET_REF",
      "DEEPSONAR_TARGET_AUTHORITY_ACTIONS",
      "DEEPSONAR_TARGET_AUTHORITY_TIMEOUT_MS",
      "DEEPSONAR_TARGET_AUTHORITY_MAX_BODY_BYTES",
      "TARGET_FIXTURE_SECRET",
    ] as const;
    const previousEnvironment = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    ) as Record<string, string | undefined>;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.BLOB_DIR = blobDir;

      const [
        { sql, migrate },
        { default: Fastify },
        { default: websocket },
        { registerRoutes },
        { generateToken },
        core,
        api,
        { createAttempt },
        { taskContractPreflight },
        { ControlInputError },
        dispatcher,
      ] = await Promise.all([
        import("../../db.js"),
        import("fastify"),
        import("@fastify/websocket"),
        import("../../routes.js"),
        import("../../auth.js"),
        import("../../core.js"),
        import("../platform-api/index.js"),
        import("../job-attempt/index.js"),
        import("../../task-contract-preflight.js"),
        import("../../control-input.js"),
        import("../../dispatcher.js"),
      ]);
      endSql = () => sql.end({ timeout: 5 });
      drainDispatcher = () => dispatcher.drainInFlight(15_000);
      await migrate();

      const app = Fastify({ logger: false });
      closeApp = () => app.close();
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();

      const projectId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'target authorization fixture')`;

      server = createServer(async (req, res) => handleAuthority(req, res, fixture));
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const config = createTargetAuthorizationConfig({
        authorityUrl: `http://127.0.0.1:${address.port}/authorize`,
        authorityId: "local-reference-authority",
        secretRef: "TARGET_FIXTURE_SECRET",
        requestedActions: REFERENCE_TARGET_ACTIONS,
        maxAgeSeconds: 60,
        timeoutMs: 250,
        maxBodyBytes: 4096,
      });
      process.env.DEEPSONAR_TARGET_AUTHORITY_URL = config.authorityUrl;
      process.env.DEEPSONAR_TARGET_AUTHORITY_ID = config.authorityId;
      process.env.DEEPSONAR_TARGET_AUTHORITY_SECRET_REF = config.secretRef;
      process.env.DEEPSONAR_TARGET_AUTHORITY_ACTIONS = [...REFERENCE_TARGET_ACTIONS].join(",");
      process.env.DEEPSONAR_TARGET_AUTHORITY_TIMEOUT_MS = String(config.timeoutMs);
      process.env.DEEPSONAR_TARGET_AUTHORITY_MAX_BODY_BYTES = String(config.maxBodyBytes);
      process.env.TARGET_FIXTURE_SECRET = fixture.secret;
      const fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

      const operator = generateToken();
      const [operatorRow] = await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('target authorization operator', ${projectId}, ${operator.prefix}, ${operator.hash}, ${["tasks:read", "tasks:write", "jobs:control"]})
        RETURNING id`;
      const principalId = String(operatorRow.id);
      fixture.principalId = principalId;
      const headers = { authorization: `Bearer ${operator.plaintext}` };

      const contract = normalizeTaskContract({
        schema_version: 1,
        template_id: "blackbox",
        template_version: 1,
        objective: "Verify the isolated test-tenant lifecycle",
        targets: ["reference-http/v1:test-tenant/save-publish-trigger"],
        scope: ["test tenant only"],
        acceptance: ["save publish trigger are separately authorized"],
        evidence: ["local authority response"],
        stop_conditions: ["stop at tenant boundary"],
        allowed_actions: ["read", "write"],
        required_actions: ["read", "write"],
        identity: { tenant: "test-tenant", role: "editor", resource: "save-publish-trigger" },
        prerequisites: [{ id: "fixture-ready", required: true, state: "declared", description: "Fixture is ready" }],
      });
      const content = "save -> publish -> trigger";

      const wrongPrincipal = await taskContractPreflight(sql, projectId, contract, false, {
        principalId: "not-the-fixture-principal",
        content,
        detailed: true,
      });
      assert.ok(wrongPrincipal.blockers.some((item) => item.code === "target_authorization_scope_mismatch" || item.code === "target_authorization_denied"));

      const wrongTenant = normalizeTaskContract({
        ...contract,
        identity: { tenant: "other-tenant", role: "editor", resource: "save-publish-trigger" },
      });
      const wrongTenantBlockers = await taskContractPreflight(sql, projectId, wrongTenant, false, { principalId, content });
      assert.ok(wrongTenantBlockers.some((item) => item.code === "target_authorization_scope_mismatch"));

      const wrongResource = normalizeTaskContract({
        ...contract,
        targets: ["reference-http/v1:test-tenant/other-resource"],
        identity: { tenant: "test-tenant", role: "editor", resource: "other-resource" },
      });
      const wrongResourceBlockers = await taskContractPreflight(sql, projectId, wrongResource, false, { principalId, content });
      assert.ok(wrongResourceBlockers.some((item) => item.code === "target_authorization_scope_mismatch" || item.code === "target_authorization_denied"));

      fixture.prerequisiteUnavailable = true;
      const prerequisite = await taskContractPreflight(sql, projectId, contract, false, { principalId, content });
      assert.ok(prerequisite.some((item) => item.code === "target_authorization_prerequisite_blocked"));
      fixture.prerequisiteUnavailable = false;

      fixture.malformed = true;
      const malformed = await taskContractPreflight(sql, projectId, contract, false, { principalId, content });
      assert.ok(malformed.some((item) => item.code === "target_authorization_malformed"));
      fixture.malformed = false;

      const forgedGrant = {
        protocol: "deepsonar.target-authorization/v1",
        principal_id: "attacker",
        authority_revision: "forged",
      };
      // CreateTaskBody is a stripping Zod object. Extra root fields are ignored;
      // only the strict nested task_contract is a client contract.
      const created = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/tasks`,
        headers,
        payload: {
          title: "Trusted target chain",
          content,
          task_contract: contract,
          target_authorization: forgedGrant,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const createdBody = created.json() as { canvas_id: string; job: { id: string } };
      const canvasId = createdBody.canvas_id;
      const rootJobId = String(createdBody.job.id);
      const [root] = await sql`SELECT agent_snapshot_json, payload_json FROM jobs WHERE id = ${rootJobId}`;
      const rootSnapshot = JSON.parse(JSON.stringify(root.agent_snapshot_json)) as Record<string, any>;
      const rootAuthorization = TargetAuthorizationSnapshot.parse(rootSnapshot.target_authorization);
      assert.equal(rootAuthorization.principal_id, principalId);
      assert.equal(rootAuthorization.authority_revision, "policy-1");
      assert.notDeepEqual(rootAuthorization, forgedGrant);
      const [createdCanvas] = await sql`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
      assert.equal(createdCanvas.target_json.target_authorization, undefined);
      assert.equal((root.payload_json as Record<string, unknown>).target_authorization, undefined);
      assert.equal((root.payload_json as Record<string, unknown>).content, content);
      assert.equal(fixture.requests.length, 5, "remote negative preflight cases and root creation must all use the authority");
      assert.equal(fixture.requests.at(-1)?.project_id, projectId);
      assert.equal((fixture.requests.at(-1)?.principal as { id?: string }).id, principalId);
      assert.equal((fixture.requests.at(-1)?.identity as { tenant?: string }).tenant, "test-tenant");
      assert.equal((fixture.requests.at(-1)?.target as { target_id?: string }).target_id, "test-tenant/save-publish-trigger");
      assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)), /save -> publish -> trigger/);
      assert.deepEqual(fixture.targetPaths, [], "authorization must not probe target writes");

      const grantsAfterCreate = await sql`
        SELECT actor_type, actor_id, action, after_json
        FROM audit_logs
        WHERE action = 'task.target_authorization' AND project_id = ${projectId}
        ORDER BY id`;
      assert.equal(grantsAfterCreate.length, 1);
      assert.equal(grantsAfterCreate[0].actor_type, "system");
      assert.equal(grantsAfterCreate[0].actor_id, "target-authorization");
      assert.equal(grantsAfterCreate[0].after_json.binding.content_sha256, rootAuthorization.content_sha256);
      assert.doesNotMatch(JSON.stringify(grantsAfterCreate[0].after_json), /target-auth-fixture-value|save -> publish -> trigger/);

      const runtime = async (jobId: string, operations: readonly string[]) => {
        await sql`UPDATE jobs SET status = 'provisioning' WHERE id = ${jobId}`;
        const attempt = await createAttempt(sql, jobId);
        const capability = await api.mintJobCapabilityToken(jobId);
        await sql`UPDATE jobs SET status = 'running', started_at = now(), lease_expires_at = now() + interval '10 minutes' WHERE id = ${jobId}`;
        await api.activateProvisionedJobCapabilityTokens(jobId);
        const handler = (async (context: import("../platform-api/index.js").PlatformRuntimeHandlerContext) => {
          if (context.planPhase === "resolve") return {};
          if (context.planPhase === "abort") return {};
          if (context.planPhase === "prepare") return { plan_prepared: true };
          if (context.operationId === "mark_job_done" && context.completionPhase !== "commit") {
            return { completion_prepared: context.completionPhase === "prepare" };
          }
          const eventType = context.operationId === "submit_hub_decision" ? "hub_decision"
            : context.operationId === "emit_fact" ? "fact" : "done";
          try {
            if (eventType === "hub_decision" && context.planPhase !== "commit") {
              await core.preflightDeferredSemanticEvent(jobId, eventType, context.input);
              if (context.planPhase === "validate") return {};
            }
            await core.ingestEvent(jobId, {
              v: 1,
              event_id: context.eventId,
              type: eventType,
              payload: context.input,
            } as never);
            return { accepted: true, event_id: context.eventId };
          } catch (error) {
            if (error instanceof ControlInputError) {
              throw new api.PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
                statusCode: error.retryable ? 422 : 409,
                errorCode: error.code,
                retryable: error.retryable,
                path: error.path,
              });
            }
            throw error;
          }
        }) as import("../platform-api/index.js").PlatformRuntimeHandler;
        api.registerRuntimeHandler(jobId, handler, operations);
        registeredRuntimeHandlers.push(jobId);
        return { id: jobId, attemptId: String(attempt.id), token: capability.token };
      };
      const invoke = (run: { id: string; token: string }, operation: string, payload: unknown, idempotencyKey = randomUUID()) => app.inject({
        method: "POST",
        url: `/control/v1/jobs/${run.id}/operations/${operation}`,
        headers: {
          authorization: `Bearer ${run.token}`,
          "idempotency-key": idempotencyKey,
          ...(operation === "mark_job_done" ? { "x-deepsonar-proposal-revision": "0" } : {}),
        },
        payload: payload as never,
      });

      const rootNode = await sql`SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
      assert.equal(rootNode.length, 1);
      const rootRun = await runtime(rootJobId, ["submit_hub_decision", "mark_job_done"]);
      const decision = await invoke(rootRun, "submit_hub_decision", {
        intents: [{
          from: [String(rootNode[0].id)],
          role: "audit",
          description: "Execute the authorized fixture lifecycle",
          prompt: "Perform the authorized save, publish, and trigger lifecycle and retain a structured fact.",
        }],
      });
      assert.equal(decision.statusCode, 200, decision.payload);
      const rootDone = await invoke(rootRun, "mark_job_done", { summary: "Hub decision submitted for the target-authorized Worker" });
      assert.equal(rootDone.statusCode, 200, rootDone.payload);

      const [child] = await sql`
        SELECT id, type, status, parent_job_id, payload_json, agent_snapshot_json
        FROM jobs WHERE parent_job_id = ${rootJobId} ORDER BY created_at DESC LIMIT 1`;
      assert.ok(child, "Control ingestion must create a Worker Job");
      const childId = String(child.id);
      const childSnapshot = JSON.parse(JSON.stringify(child.agent_snapshot_json)) as Record<string, any>;
      const childAuthorization = TargetAuthorizationSnapshot.parse(childSnapshot.target_authorization);
      assert.equal(child.type, "audit");
      assert.equal(child.parent_job_id, rootJobId);
      assert.equal((child.payload_json as Record<string, unknown>).content, undefined);
      assert.deepEqual(childSnapshot.target_authorization, rootAuthorization);
      assert.deepEqual(childSnapshot.task_contract, rootSnapshot.task_contract);

      const forgedCanvasMetadata = { ...rootAuthorization, authority_revision: "forged-canvas-metadata" };
      await sql`UPDATE canvases SET target_json = target_json || ${sql.json({ target_authorization: forgedCanvasMetadata } as never)} WHERE id = ${canvasId}`;
      const followup = await core.createJob({
        projectId,
        canvasId,
        type: "hub_reason",
        payload: { trigger: { kind: "system_followup" } },
      });
      assert.ok(followup.job);
      const followupSnapshot = JSON.parse(JSON.stringify((followup.job as Record<string, any>).agent_snapshot_json)) as Record<string, any>;
      assert.deepEqual(followupSnapshot.target_authorization, rootAuthorization, "Canvas metadata cannot replace the host grant");
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${followup.job.id}`;

      assert.equal(fixture.targetPaths.length, 0);
      const checkChild = () => taskContractPreflight(sql, projectId, contract, false, {
        principalId,
        frozenTargetAuthorization: childSnapshot.target_authorization,
        requireFrozenTargetAuthorization: true,
      });
      fixture.prerequisiteUnavailable = true;
      assert.ok((await checkChild()).some((item) => item.code === "target_authorization_prerequisite_blocked"));
      fixture.prerequisiteUnavailable = false;
      fixture.authorityRevision = "policy-2";
      assert.ok((await checkChild()).some((item) => item.code === "target_authorization_policy_changed"));
      fixture.authorityRevision = "policy-1";
      for (const scopeOverride of [
        { principal_id: "other-principal" }, { tenant: "other-tenant" },
        { role: "reader" }, { resource: "other-resource" },
        { project_id: randomUUID() },
        { target: { adapter: "reference-http/v1" as const, target_id: "test-tenant/other-resource" } },
      ]) {
        fixture.scopeOverride = scopeOverride;
        assert.ok((await checkChild()).some((item) => item.code === "target_authorization_scope_mismatch"));
      }
      fixture.scopeOverride = {};

      // TEST-ONLY Worker driver: use a real Attempt, running lease and Control
      // operations, following the Plan integration harness. No fake Dispatcher
      // branch, production target executor or model is involved.
      const childRun = await runtime(childId, ["emit_fact", "mark_job_done"]);
      const [runningChild] = await sql`SELECT status, lease_expires_at FROM jobs WHERE id = ${childId}`;
      assert.equal(runningChild.status, "running");
      assert.ok(new Date(runningChild.lease_expires_at).getTime() > Date.now());
      const [childAttempt] = await sql`SELECT status FROM job_attempts WHERE id = ${childRun.attemptId} AND job_id = ${childId}`;
      assert.equal(childAttempt.status, "active");
      assert.deepEqual(await checkChild(), [], "current authority and prerequisites must be checked immediately before fixture actions");
      const actions = await executeReferenceTargetFixture(childAuthorization, {
        jobId: childId, fixtureBaseUrl, fixtureCredential: TARGET_FIXTURE_CREDENTIAL,
      });
      assert.equal(fixture.targetState, "triggered");
      assert.deepEqual(actions.map((item) => JSON.parse(item.body).state), ["saved", "published", "triggered"]);
      const uri = `attempts/${childRun.attemptId}/target-actions.json`;
      const evidenceBytes = Buffer.from(JSON.stringify({
        fixture: true, job_id: childId, attempt_id: childRun.attemptId,
        target_id: rootAuthorization.target_id, actions,
        binding: grantsAfterCreate[0].after_json.binding,
      }));
      const sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
      const jobBlobDir = path.join(blobDir, "jobs", childId);
      await mkdir(path.dirname(path.join(jobBlobDir, uri)), { recursive: true });
      await writeFile(path.join(jobBlobDir, uri), evidenceBytes);
      await writeFile(path.join(jobBlobDir, "manifest.json"), JSON.stringify({
        job_id: childId, finalized_at: new Date().toISOString(),
        files: [{ path: uri, bytes: evidenceBytes.length, sha256 }],
      }));
      const observed = await invoke(childRun, "emit_fact", {
        title: "Loopback fixture action chain completed",
        description: "The test-only Worker retained the isolated save, publish and trigger HTTP results.",
        artifact: {
          artifact_key: "target-fixture-actions", kind: "fact",
          evidence: [{ statement: "Retained loopback fixture action results", uri, sha256 }],
        },
      });
      assert.equal(observed.statusCode, 200, observed.payload);
      const workerDone = await invoke(childRun, "mark_job_done", { summary: "Retained the isolated target fixture evidence" });
      assert.equal(workerDone.statusCode, 200, workerDone.payload);
      const [completedChild] = await sql`SELECT status, sandbox_id FROM jobs WHERE id = ${childId}`;
      assert.equal(completedChild.status, "succeeded");
      assert.equal(completedChild.sandbox_id, null, "the offline Worker is a test-only driver");
      assert.deepEqual(fixture.targetPaths, ["/save", "/publish", "/trigger"]);
      assert.equal(fixture.targetRequests.length, 3);
      assert.ok(fixture.targetRequests.every((request) => request.content_sha256 === rootAuthorization.content_sha256));
      assert.ok(fixture.targetRequests.every((request) => !JSON.stringify(request).includes(fixture.secret)));
      const childEvents = await sql`SELECT event_id, attempt_id, type, payload_json FROM events WHERE job_id = ${childId} ORDER BY created_at, id`;
      assert.deepEqual(childEvents.map((event) => event.type), ["fact", "control_receipt", "done"]);
      assert.ok(childEvents.every((event) => event.attempt_id === childRun.attemptId));
      const [systemFollowOn] = await sql`
        SELECT id, status, agent_snapshot_json FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
          AND id <> ${rootJobId} AND id <> ${followup.job.id}
        ORDER BY created_at DESC LIMIT 1`;
      assert.ok(systemFollowOn, "Worker completion must use the existing Hub follow-on path");
      assert.deepEqual(systemFollowOn.agent_snapshot_json.target_authorization, rootAuthorization);
      assert.deepEqual(systemFollowOn.agent_snapshot_json.task_contract, rootSnapshot.task_contract);
      const [retained] = await sql`
        SELECT a.source_event_id, a.source_operation, e.uri, e.sha256
        FROM artifacts a JOIN artifact_evidence e ON e.artifact_id = a.id
        WHERE a.job_id = ${childId} AND a.artifact_key = 'target-fixture-actions'`;
      assert.ok(retained);
      assert.equal(retained.source_event_id, childEvents[0].event_id);
      assert.equal(retained.source_operation, "emit_fact");
      assert.equal(retained.sha256, sha256);
      assert.deepEqual(await readFile(path.join(jobBlobDir, retained.uri)), evidenceBytes);
      assert.doesNotMatch(evidenceBytes.toString(), /target-auth-fixture-value|reference-target-fixture-only/);

      const oldRootSnapshot = JSON.parse(JSON.stringify(rootSnapshot));
      const oldChildSnapshot = JSON.parse(JSON.stringify(childSnapshot));
      const updatedContent = "updated authorized content after the first Worker";
      const patched = await app.inject({
        method: "PATCH",
        url: `/tasks/${canvasId}`,
        headers,
        payload: { content: updatedContent },
      });
      assert.equal(patched.statusCode, 200, patched.payload);
      const [updatedCanvas] = await sql`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
      assert.equal(updatedCanvas.target_json.content, updatedContent);
      const [unchangedRoot] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${rootJobId}`;
      const [unchangedChild] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${childId}`;
      assert.deepEqual(unchangedRoot.agent_snapshot_json, oldRootSnapshot);
      assert.deepEqual(unchangedChild.agent_snapshot_json, oldChildSnapshot);
      const grantsAfterPatch = await sql`
        SELECT after_json FROM audit_logs
        WHERE action = 'task.target_authorization' AND project_id = ${projectId}
        ORDER BY id`;
      assert.equal(grantsAfterPatch.length, 2);
      assert.notEqual(grantsAfterPatch[0].after_json.binding.content_sha256, grantsAfterPatch[1].after_json.binding.content_sha256);

      const negative = await core.createJob({
        projectId,
        canvasId,
        type: "audit",
        payload: { intent: { description: "Revocation fixture", prompt: "The payload intentionally omits the original target content." } },
      });
      assert.ok(negative.job);
      const negativeId = String(negative.job.id);
      const negativeSnapshot = JSON.parse(JSON.stringify((negative.job as Record<string, any>).agent_snapshot_json)) as Record<string, any>;
      assert.equal((negative.job as Record<string, any>).payload_json.content, undefined);
      assert.equal(negativeSnapshot.target_authorization.content_sha256, grantsAfterPatch[1].after_json.binding.content_sha256);
      const negativeSnapshotBeforeDispatch = JSON.parse(JSON.stringify(negativeSnapshot));
      const targetActionsBeforeRevocation = fixture.targetPaths.length;
      fixture.revoked = true;
      const { runner } = await import("../../runtime.js");
      const provision = t.mock.method(runner, "provision", async () => {
        throw new Error("revoked target must not reach sandbox provision");
      });
      await dispatcher.dispatchOnce();
      await dispatcher.drainInFlight(15_000);
      const [revokedJob] = await sql`SELECT status, sandbox_id FROM jobs WHERE id = ${negativeId}`;
      assert.equal(revokedJob.status, "failed");
      assert.equal(revokedJob.sandbox_id, null);
      assert.equal(fixture.targetPaths.length, targetActionsBeforeRevocation, "revocation must block before target actions");
      const [provisionEffects] = await sql`SELECT count(*)::int AS count FROM job_attempt_effects WHERE job_id = ${negativeId} AND effect_kind = 'provision'`;
      assert.equal(provisionEffects.count, 0, "revocation must block before the provision effect");
      assert.equal(provision.mock.callCount(), 0, "revocation must block before any sandbox provision call");
      const [attemptCountBeforeRerun] = await sql`SELECT count(*)::int AS count FROM job_attempts WHERE job_id = ${negativeId}`;
      const resume = await app.inject({ method: "POST", url: `/jobs/${negativeId}/resume`, headers });
      assert.equal(resume.statusCode, 409, resume.payload);
      assert.equal(resume.json().error_code, "TARGET_AUTHORIZATION_BLOCKED");
      const rerunCurrent = await app.inject({ method: "POST", url: `/jobs/${negativeId}/rerun-current`, headers });
      assert.equal(rerunCurrent.statusCode, 409, rerunCurrent.payload);
      assert.equal(rerunCurrent.json().error_code, "TARGET_AUTHORIZATION_BLOCKED");
      const [unchangedNegative] = await sql`SELECT status, agent_snapshot_json FROM jobs WHERE id = ${negativeId}`;
      assert.equal(unchangedNegative.status, "failed");
      assert.deepEqual(unchangedNegative.agent_snapshot_json, negativeSnapshotBeforeDispatch);
      const [attemptCountAfterRerun] = await sql`SELECT count(*)::int AS count FROM job_attempts WHERE job_id = ${negativeId}`;
      assert.equal(attemptCountAfterRerun.count, attemptCountBeforeRerun.count);
      await dispatcher.dispatchOnce();
      await dispatcher.drainInFlight(15_000);
      const [attemptCountAfterDispatch] = await sql`SELECT count(*)::int AS count FROM job_attempts WHERE job_id = ${negativeId}`;
      assert.equal(attemptCountAfterDispatch.count, attemptCountBeforeRerun.count, "the failed Job must not be replayed when follow-on Jobs are claimed");
      assert.equal(fixture.targetPaths.length, targetActionsBeforeRevocation);
      assert.equal(provision.mock.callCount(), 0);

      const [rowsBeforeRejectedCreate] = await sql`
        SELECT (SELECT count(*)::int FROM canvases) AS canvases, (SELECT count(*)::int FROM jobs) AS jobs`;
      const rejectedCreate = await app.inject({
        method: "POST", url: `/projects/${projectId}/tasks`, headers,
        payload: { title: "Revoked creation", content, task_contract: contract, target_authorization: forgedGrant },
      });
      assert.equal(rejectedCreate.statusCode, 409, rejectedCreate.payload);
      assert.equal(rejectedCreate.json().error_code, "task_contract_blocked");
      const [rowsAfterRejectedCreate] = await sql`
        SELECT (SELECT count(*)::int FROM canvases) AS canvases, (SELECT count(*)::int FROM jobs) AS jobs`;
      assert.deepEqual(rowsAfterRejectedCreate, rowsBeforeRejectedCreate);
      const rejectedPatch = await app.inject({
        method: "PATCH", url: `/tasks/${canvasId}`, headers,
        payload: { content: "revoked edit must remain uncommitted" },
      });
      assert.equal(rejectedPatch.statusCode, 409, rejectedPatch.payload);
      const [canvasAfterRejectedPatch] = await sql`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
      assert.deepEqual(canvasAfterRejectedPatch.target_json, updatedCanvas.target_json);
      const grantsAfterRejectedPatch = await sql`
        SELECT after_json FROM audit_logs WHERE action = 'task.target_authorization' AND project_id = ${projectId} ORDER BY id`;
      assert.deepEqual(grantsAfterRejectedPatch, grantsAfterPatch);
      assert.ok(fixture.requests.length > 5, "the Worker and rerun paths must consult the live authority");

      fixture.revoked = false;
      await sql`UPDATE jobs SET status='cancelled', finished_at=now()
        WHERE canvas_id=${canvasId} AND type='hub_reason' AND status='pending'`;
      const drift = await core.createJob({ projectId, canvasId, type: "audit", payload: {} });
      assert.ok(drift.job);
      const driftId = String(drift.job.id);
      const [beforeDrift] = await sql`SELECT count(*)::int AS count FROM jobs WHERE canvas_id=${canvasId}`;
      process.env.DEEPSONAR_TARGET_AUTHORITY_ID = "changed-authority";
      await dispatcher.dispatchOnce();
      await dispatcher.drainInFlight(15_000);
      const [drifted] = await sql`SELECT status, sandbox_id FROM jobs WHERE id=${driftId}`;
      assert.equal(drifted.status, "failed", "authority configuration drift must durably fail the Job even when follow-on Hub admission is denied");
      assert.equal(drifted.sandbox_id, null);
      assert.equal(provision.mock.callCount(), 0);
      const [afterDrift] = await sql`SELECT count(*)::int AS count FROM jobs WHERE canvas_id=${canvasId}`;
      assert.equal(afterDrift.count, beforeDrift.count, "denied follow-on admission must not create partial Jobs");
      const convergence = await core.readCanvasConvergence(sql, canvasId);
      assert.equal(convergence.auto_stopped, true);
      assert.equal(convergence.paused_reason, "target_authorization_grant_invalid");
    } finally {
      if (drainDispatcher) await drainDispatcher();
      for (const jobId of registeredRuntimeHandlers) {
        try {
          const api = await import("../platform-api/index.js");
          api.unregisterRuntimeHandler(jobId);
        } catch {
          // Continue teardown after partial fixture setup.
        }
      }
      if (closeApp) await closeApp().catch(() => undefined);
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      for (const key of environmentKeys) {
        const previous = previousEnvironment[key];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await rm(blobDir, { recursive: true, force: true });
    }
  });
}

async function handleAuthority(
  req: IncomingMessage,
  res: ServerResponse,
  fixture: {
    revoked: boolean;
    prerequisiteUnavailable: boolean;
    malformed: boolean;
    authorityRevision: string;
    scopeOverride: Partial<TargetAuthorizationResponse["scope"]>;
    requests: Array<Record<string, unknown>>;
    targetRequests: Array<Record<string, unknown>>;
    targetPaths: string[];
    targetState: string;
    secret: string;
    principalId?: string;
  },
): Promise<void> {
  if (req.method === "POST" && ["/save", "/publish", "/trigger"].includes(req.url ?? "")) {
    const authorization = req.headers.authorization;
    const body = await readBody(req, 4096);
    const request = JSON.parse(body) as Record<string, unknown>;
    fixture.targetPaths.push(req.url ?? "");
    fixture.targetRequests.push(request);
    const expectedAction = `reference-http.${req.url!.slice(1)}`;
    if (authorization !== `Bearer ${TARGET_FIXTURE_CREDENTIAL}` || fixture.revoked
      || fixture.prerequisiteUnavailable || request.action !== expectedAction
      || request.principal_id !== fixture.principalId
      || request.tenant !== "test-tenant" || request.role !== "editor"
      || request.resource !== "save-publish-trigger"
      || request.target_id !== "test-tenant/save-publish-trigger") {
      writeJson(res, 403, { ok: false });
      return;
    }
    const transition: Record<string, [string, string]> = {
      "/save": ["empty", "saved"], "/publish": ["saved", "published"], "/trigger": ["published", "triggered"],
    };
    const [from, to] = transition[req.url!];
    if (fixture.targetState !== from) {
      writeJson(res, 409, { ok: false });
      return;
    }
    fixture.targetState = to;
    writeJson(res, 200, { ok: true, action: request.action, state: fixture.targetState });
    return;
  }
  if (req.method !== "POST" || req.url !== "/authorize") {
    res.writeHead(404).end();
    return;
  }
  const authorization = req.headers.authorization;
  const body = await readBody(req, 4096);
  const request = JSON.parse(body) as Record<string, unknown>;
  fixture.requests.push(request);
  if (authorization !== `Bearer ${fixture.secret}`) {
    writeJson(res, 200, deny(request, "not_authorized"));
    return;
  }
  if (fixture.revoked) {
    writeJson(res, 200, deny(request, "revoked"));
    return;
  }
  if (fixture.prerequisiteUnavailable) {
    writeJson(res, 200, deny(request, "prerequisite_unavailable"));
    return;
  }
  if (fixture.malformed) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{malformed");
    return;
  }
  const identity = request.identity as { tenant: string; role: string; resource: string };
  const target = request.target as { adapter: "reference-http/v1"; target_id: string };
  const principal = request.principal as { id: string };
  const allowed = request.project_id
    && identity.tenant === "test-tenant"
    && identity.role === "editor"
    && identity.resource === "save-publish-trigger"
    && target.target_id === "test-tenant/save-publish-trigger"
    && principal.id === (fixture.principalId ?? "fixture-principal")
    && JSON.stringify(request.requested_actions) === JSON.stringify([...REFERENCE_TARGET_ACTIONS]);
  if (!allowed) {
    writeJson(res, 200, deny(request, "scope_mismatch"));
    return;
  }
  const response: TargetAuthorizationResponse = {
    protocol: "deepsonar.target-authorization/v1",
    authority_id: request.authority_id as string,
    config_identity: request.config_identity as string,
    decision: "allow",
    authority_revision: fixture.authorityRevision,
    expires_at: new Date(Date.parse((request.freshness as { requested_at: string }).requested_at) + 30_000).toISOString(),
    scope: {
      project_id: request.project_id as string,
      target,
      principal_id: principal.id,
      tenant: identity.tenant,
      role: identity.role,
      resource: identity.resource,
      ...fixture.scopeOverride,
    },
    actions: [...REFERENCE_TARGET_ACTIONS].map((action) => ({ action, effect: "allow" as const })),
    prerequisites: (request.prerequisites as Array<{ id: string }>).map((item) => ({ id: item.id, status: "satisfied" as const })),
    binding: request.binding as TargetAuthorizationResponse["binding"],
  };
  writeJson(res, 200, response);
}

function deny(
  request: Record<string, unknown>,
  reason_code: "not_authorized" | "scope_mismatch" | "prerequisite_unavailable" | "revoked",
): TargetAuthorizationResponse {
  const identity = request.identity as { tenant: string; role: string; resource: string };
  const target = request.target as { adapter: "reference-http/v1"; target_id: string };
  const principal = request.principal as { id: string };
  return {
    protocol: "deepsonar.target-authorization/v1",
    authority_id: request.authority_id as string,
    config_identity: request.config_identity as string,
    decision: "deny",
    reason_code,
    authority_revision: "policy-1",
    expires_at: new Date(Date.parse((request.freshness as { requested_at: string }).requested_at) + 30_000).toISOString(),
    scope: {
      project_id: request.project_id as string,
      target,
      principal_id: principal.id,
      tenant: identity.tenant,
      role: identity.role,
      resource: identity.resource,
    },
    actions: [],
    prerequisites: [],
    binding: request.binding as TargetAuthorizationResponse["binding"],
  };
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("fixture request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, total).toString("utf8")));
    req.on("error", reject);
  });
}
