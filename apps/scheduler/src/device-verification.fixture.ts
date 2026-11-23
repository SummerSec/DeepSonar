import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { sql } from "./db.js";
import { registerRoutes } from "./routes.js";
import { createJob, ingestEvent } from "./core.js";
import { ControlInputError } from "./control-input.js";
import { createAttempt } from "./domains/job-attempt/index.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { acquireDeviceLeaseForJob, releaseDeviceLeasesForJob } from "./domains/device/index.js";
import { mintJobCapabilityToken, registerRuntimeHandler, unregisterRuntimeHandler } from "./domains/platform-api/index.js";

/** Web's explicit create payload → Canvas → frozen snapshots → role-specific broker grant. */
export async function verifyTaskDeviceCreation(projectId: string) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  try {
    const device = { transport: "hdc", key: "target-oh-1", exclusive: true, ttl_sec: 1800, roles: ["test"] };
    const create = (payload: Record<string, unknown>) => app.inject({
      method: "POST", url: `/projects/${projectId}/tasks`,
      payload: { title: "显式设备需求", content: "核对已授权的设备连通性", ...payload },
    });
    const plain = await create({});
    assert.equal(plain.statusCode, 201, plain.payload);
    const [plainJob] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${plain.json().job.id}`;
    assert.equal(plainJob.agent_snapshot_json.device_requirement, undefined);
    const counts = async () => (await sql`SELECT
      (SELECT count(*)::int FROM canvases WHERE project_id=${projectId}) AS canvases,
      (SELECT count(*)::int FROM canvas_nodes WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id=${projectId})) AS nodes,
      (SELECT count(*)::int FROM jobs WHERE project_id=${projectId}) AS jobs`)[0];
    const beforeDenied = await counts();
    for (const payload of [{ device, allow_egress: false }, { device: { ...device, rig_id: "unconfigured" }, allow_egress: true }]) {
      const denied = await create(payload);
      assert.equal(denied.statusCode, 409, denied.payload);
      assert.equal(denied.json().error_code, "device_not_authorized");
      assert.deepEqual(await counts(), beforeDenied, "device admission rejection leaves no Canvas, root or Job");
    }
    await sql`UPDATE projects SET config_json=jsonb_set(config_json,'{device_access_enabled}','false') WHERE id=${projectId}`;
    const optOut = await create({ device, allow_egress: true });
    assert.equal(optOut.statusCode, 409, optOut.payload);
    assert.equal(optOut.json().error_code, "device_not_authorized");
    assert.deepEqual(await counts(), beforeDenied, "project opt-out rolls back the entire task creation");
    await sql`UPDATE projects SET config_json=jsonb_set(config_json,'{device_access_enabled}','true') WHERE id=${projectId}`;
    const response = await create({ device, allow_egress: true });
    assert.equal(response.statusCode, 201, response.payload);
    const { canvas_id: canvasId, job: hub } = response.json();
    const [canvas] = await sql`SELECT target_json FROM canvases WHERE id=${canvasId}`;
    const [hubJob] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${hub.id}`;
    assert.deepEqual(canvas.target_json.device_requirement, device);
    assert.deepEqual(hubJob.agent_snapshot_json.device_requirement, device);
    assert.equal(await acquireDeviceLeaseForJob({ jobId: hub.id, attemptId: randomUUID(), projectId,
      roleName: "hub_reason", snapshot: hubJob.agent_snapshot_json }), null);
    const { job } = await createJob({ projectId, canvasId, type: "test", payload: { goal: "验证已授权设备连通性" } });
    assert.ok(job);
    const [worker] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${String(job.id)}`;
    assert.deepEqual(worker.agent_snapshot_json.device_requirement, device);
    const lifecycle = createSqlJobLifecycleApplication(sql);
    assert.ok(await lifecycle.claimPendingJob(String(job.id)));
    assert.ok(await lifecycle.transitionJob(String(job.id), "provisioning"));
    const attempt = await createAttempt(sql, String(job.id));
    const lease = await acquireDeviceLeaseForJob({ jobId: String(job.id), attemptId: String(attempt.id), projectId,
      roleName: "test", snapshot: worker.agent_snapshot_json });
    assert.ok(lease);
    assert.equal(lease.env.DEEPSONAR_DEVICE_TRANSPORT, "hdc");
    assert.equal((await sql`SELECT state FROM device_leases WHERE job_id=${String(job.id)}`)[0].state, "active");
    await releaseDeviceLeasesForJob(String(job.id), "attempt_terminal");
  } finally {
    await app.close();
  }
}

/** 真实管理/Control HTTP → 冻结快照 → 已有 broker 租约入口。 */
export async function verifyDeviceEvidenceEntrypoints(projectId: string) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  const hubs: string[] = [];
  try {
    await sql`UPDATE projects SET config_json = config_json || ${sql.json({
      roles: { enabled: ["review", "test"] }, rules: { hubEnabled: false, maxFollowupDepth: 12 },
    })} WHERE id = ${projectId}`;
    for (const transport of ["adb", "hdc"] as const) {
      for (const mode of ["manual", "hub"] as const) {
        const canvasId = randomUUID();
        const sourceId = randomUUID();
        const findingId = randomUUID();
        const nodeId = randomUUID();
        const requirement = { transport, key: transport === "hdc" ? "target-oh-1" : "rig-1", exclusive: true, ttl_sec: 600, roles: ["test"] };
        const target = { network_policy: { allow_egress: true }, device_requirement: requirement };
        await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES (${canvasId},${projectId},'设备补证正常入口',${sql.json(target)})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES (${canvasId},'root','root','active')`;
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
          VALUES (${sourceId},${projectId},${canvasId},'audit','succeeded','{}')`;
        await sql`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status,body_json)
          VALUES (${nodeId},${canvasId},${sourceId},'finding','设备补证对象','open',${sql.json({severity:'high'})})`;
        await sql`INSERT INTO findings(id,project_id,job_id,node_id,fingerprint,title,severity)
          VALUES (${findingId},${projectId},${sourceId},${nodeId},${findingId},'设备补证对象','high')`;
        let hubId: string | null = null;
        let deviceRejections = 0;
        let handlerFailure = "";
        let controlHeaders: Record<string, string> = {};
        if (mode === "hub") {
          hubId = randomUUID();
          hubs.push(hubId);
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,started_at,timeout_sec,lease_expires_at,payload_json,agent_snapshot_json)
            VALUES (${hubId},${projectId},${canvasId},'hub_reason','running',now(),3600,now()+interval '1 hour',
              ${sql.json({trigger:{kind:'hub_finding',finding_id:findingId}})},
              ${sql.json({name:'hub_reason',role_kind:'hub',platform_tools:['submit_hub_decision']})})`;
          await createAttempt(sql, hubId);
          const grant = await mintJobCapabilityToken(hubId);
          controlHeaders = { authorization: `Bearer ${grant.token}`, "idempotency-key": randomUUID() };
          registerRuntimeHandler(hubId, async (context) => {
            try {
              await ingestEvent(context.jobId, { v: 1, event_id: context.eventId, type: "hub_decision", payload: context.input });
            } catch (error) {
              handlerFailure = error instanceof Error ? error.message : String(error);
              if (error instanceof ControlInputError && error.code === "tool_not_allowed"
                && error.message.includes("画布设备要求")) deviceRejections++;
              throw error;
            }
            return { accepted: true };
          }, ["submit_hub_decision"]);
        }
        const invoke = () => mode === "manual"
          ? app.inject({ method: "POST", url: `/findings/${findingId}/evidence-jobs`, payload: { role: "test" } })
          : app.inject({ method: "POST", url: `/control/v1/jobs/${hubId}/operations/submit_hub_decision`,
            headers: { ...controlHeaders, "idempotency-key": randomUUID() },
            payload: { intents: [{ from: [nodeId], role: "test", description: "在授权设备上补证", prompt: "读取当前 Job 已冻结的设备要求，在授权设备上完成隔离运行测试，记录实际步骤与结果并提交结构化证据。" }] } });
        const assertDeviceDenied = async () => {
          const previousRejections = deviceRejections;
          const rejected = await invoke();
          if (mode === "manual") {
            assert.equal(rejected.statusCode, 403, rejected.payload);
            assert.equal(rejected.json().error_code, "device_not_authorized");
          } else {
            assert.ok(rejected.statusCode >= 400, rejected.payload);
            assert.equal(deviceRejections, previousRejections + 1, `${rejected.payload}; fixture handler: ${handlerFailure}`);
          }
          assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE finding_id=${findingId}`)[0].n, 0);
        };
        // 两入口均须拒绝未授权项目、禁止出网、未知 rig/transport 与非独占请求。
        for (const denied of [
          { ...target, network_policy: { allow_egress: false } },
          { ...target, device_requirement: { ...requirement, rig_id: "unconfigured" } },
          { ...target, device_requirement: { ...requirement, transport: "serial" } },
          { ...target, device_requirement: { ...requirement, exclusive: false } },
        ]) {
          await sql`UPDATE canvases SET target_json=${sql.json(denied)} WHERE id=${canvasId}`;
          await assertDeviceDenied();
        }
        await sql`UPDATE canvases SET target_json=${sql.json(target)} WHERE id=${canvasId}`;
        await sql`UPDATE projects SET config_json=jsonb_set(config_json,'{device_access_enabled}','false') WHERE id=${projectId}`;
        await assertDeviceDenied();
        await sql`UPDATE projects SET config_json=jsonb_set(config_json,'{device_access_enabled}','true') WHERE id=${projectId}`;
        const response = await invoke();
        assert.equal(response.statusCode, mode === "manual" ? 202 : 200, `${response.payload}; fixture handler: ${handlerFailure}`);
        const [created] = await sql`SELECT id,agent_snapshot_json FROM jobs WHERE finding_id=${findingId} AND type='test'`;
        assert.ok(created, response.payload);
        assert.deepEqual(created.agent_snapshot_json.device_requirement, requirement);
        const lifecycle = createSqlJobLifecycleApplication(sql);
        assert.ok(await lifecycle.claimPendingJob(String(created.id)));
        assert.ok(await lifecycle.transitionJob(String(created.id), "provisioning"));
        const attempt = await createAttempt(sql, String(created.id));
        const lease = await acquireDeviceLeaseForJob({ jobId: String(created.id), attemptId: String(attempt.id), projectId,
          roleName: "test", snapshot: created.agent_snapshot_json });
        assert.ok(lease);
        assert.equal(lease.env.DEEPSONAR_DEVICE_TRANSPORT, transport);
        assert.equal((await sql`SELECT state FROM device_leases WHERE job_id=${String(created.id)}`)[0].state, "active");
        await releaseDeviceLeasesForJob(String(created.id), "attempt_terminal");
        if (hubId) unregisterRuntimeHandler(hubId);
      }
    }
    // 显式没有设备要求仍可进行远端测试，镜像内容不作为设备能力判定。
    const remoteCanvas = randomUUID();
    const remoteSource = randomUUID();
    const remoteFinding = randomUUID();
    const remoteNode = randomUUID();
    await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES (${remoteCanvas},${projectId},'远端补证',${sql.json({network_policy:{allow_egress:true}})})`;
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES (${remoteSource},${projectId},${remoteCanvas},'audit','succeeded','{}')`;
    await sql`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status) VALUES (${remoteNode},${remoteCanvas},${remoteSource},'finding','remote','open')`;
    await sql`INSERT INTO findings(id,project_id,job_id,node_id,fingerprint,title,severity) VALUES (${remoteFinding},${projectId},${remoteSource},${remoteNode},${remoteFinding},'remote','medium')`;
    const remote = await app.inject({ method: "POST", url: `/findings/${remoteFinding}/evidence-jobs`, payload: {role:"test"} });
    assert.equal(remote.statusCode, 202, remote.payload);
    const [remoteJob] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${remote.json().job_id}`;
    assert.equal(remoteJob.agent_snapshot_json.device_requirement, undefined);
  } finally {
    for (const hubId of hubs) unregisterRuntimeHandler(hubId);
    await app.close();
  }
}
