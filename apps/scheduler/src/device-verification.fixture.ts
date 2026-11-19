import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { sql } from "./db.js";
import { registerRoutes } from "./routes.js";
import { ingestEvent } from "./core.js";
import { createAttempt } from "./domains/job-attempt/index.js";
import { acquireDeviceLeaseForJob, releaseDeviceLeasesForJob } from "./domains/device/index.js";
import { mintJobCapabilityToken, registerRuntimeHandler, unregisterRuntimeHandler } from "./domains/platform-api/index.js";

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
          VALUES (${nodeId},${canvasId},${sourceId},'finding','设备补证对象','open',${sql.json({severity:'medium'})})`;
        await sql`INSERT INTO findings(id,project_id,job_id,node_id,fingerprint,title,severity)
          VALUES (${findingId},${projectId},${sourceId},${nodeId},${findingId},'设备补证对象','medium')`;
        let hubId: string | null = null;
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
            await ingestEvent(context.jobId, { v: 1, event_id: context.eventId, type: "hub_decision", payload: context.input });
            return { accepted: true };
          }, ["submit_hub_decision"]);
        }
        const invoke = () => mode === "manual"
          ? app.inject({ method: "POST", url: `/findings/${findingId}/evidence-jobs`, payload: { role: "test" } })
          : app.inject({ method: "POST", url: `/control/v1/jobs/${hubId}/operations/submit_hub_decision`,
            headers: { ...controlHeaders, "idempotency-key": randomUUID() },
            payload: { intents: [{ from: [nodeId], role: "test", description: "在授权设备上补证", prompt: "读取已冻结的设备要求并提交结构化运行测试证据。" }] } });
        // 两入口均须拒绝未授权项目、禁止出网、未知 rig/transport 与非独占请求。
        for (const denied of [
          { ...target, network_policy: { allow_egress: false } },
          { ...target, device_requirement: { ...requirement, rig_id: "unconfigured" } },
          { ...target, device_requirement: { ...requirement, transport: "serial" } },
          { ...target, device_requirement: { ...requirement, exclusive: false } },
        ]) {
          await sql`UPDATE canvases SET target_json=${sql.json(denied)} WHERE id=${canvasId}`;
          const rejected = await invoke();
          assert.ok(rejected.statusCode >= 400, rejected.payload);
          assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE finding_id=${findingId}`)[0].n, 0);
        }
        await sql`UPDATE canvases SET target_json=${sql.json(target)} WHERE id=${canvasId}`;
        await sql`UPDATE projects SET config_json=jsonb_set(config_json,'{device_access_enabled}','false') WHERE id=${projectId}`;
        assert.ok((await invoke()).statusCode >= 400);
        await sql`UPDATE projects SET config_json=jsonb_set(config_json,'{device_access_enabled}','true') WHERE id=${projectId}`;
        const response = await invoke();
        assert.equal(response.statusCode, mode === "manual" ? 202 : 200, response.payload);
        const [created] = await sql`SELECT id,agent_snapshot_json FROM jobs WHERE finding_id=${findingId} AND type='test'`;
        assert.ok(created, response.payload);
        assert.deepEqual(created.agent_snapshot_json.device_requirement, requirement);
        await sql`UPDATE jobs SET status='provisioning' WHERE id=${String(created.id)}`;
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
