import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runMigrations, type MigrationConnection } from "./migration-runner.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";

export async function runQueueRetirementFixture(databaseUrl: string) {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `queue_retirement_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const db = postgres(url.toString(), { max: 1 });
  try {
    await runMigrations(db as unknown as MigrationConnection);
    // Reintroduce the retired source tables to exercise the real copy-back path.
    await db.unsafe(`CREATE TABLE project_task_queues (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_task_queue_items (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_task_queues(project_id) ON DELETE CASCADE,
  canvas_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT project_task_queue_canvas_fk FOREIGN KEY (project_id, canvas_id)
    REFERENCES canvases(project_id, id) ON DELETE CASCADE,
  CONSTRAINT project_task_queue_state_check CHECK (state IN ('queued', 'active', 'yielded', 'succeeded', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX project_task_queue_active_uniq ON project_task_queue_items(project_id) WHERE state = 'active';
CREATE INDEX project_task_queue_order_idx ON project_task_queue_items(project_id, state, id);
CREATE TABLE project_task_queue_yields (
  mutation_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_task_queues(project_id) ON DELETE CASCADE,
  canvas_id text NOT NULL,
  source_item_id bigint NOT NULL,
  request_id uuid NOT NULL UNIQUE REFERENCES human_requests(id) ON DELETE CASCADE,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  reply_message_id uuid,
  requeued_item_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  requeued_at timestamptz,
  FOREIGN KEY (project_id,canvas_id) REFERENCES canvases(project_id,id) ON DELETE CASCADE,
  CHECK ((reply_message_id IS NULL AND requeued_item_id IS NULL AND requeued_at IS NULL)
    OR (reply_message_id IS NOT NULL AND requeued_item_id IS NOT NULL AND requeued_at IS NOT NULL))
);
UPDATE schema_meta SET version=77`);
    const cases = [
      { name: "manual", paused: true, state: "queued", job: "pending", expected: true },
      { name: "failure", paused: true, state: "queued", job: "pending", expected: true },
      { name: "cancelled", paused: true, state: "active", job: "cancelled", expected: true },
      { name: "human_reply", paused: true, state: "queued", job: "waiting_human", expected: true },
      { name: "running", paused: true, state: "active", job: "running", expected: false },
      { name: "ordinary", paused: false, state: "queued", job: "pending", expected: false },
      { name: "acknowledged", paused: false, state: "failed", job: "failed", expected: false },
      { name: "task_pause", paused: false, state: "queued", job: "pending", expected: true },
    ];
    for (const item of cases) {
      const project = randomUUID();
      const target = item.name === "task_pause"
        ? { execution_control: { paused: true, reason: "manual_pause", paused_by: "operator" } } : {};
      await db`INSERT INTO projects(id,name) VALUES(${project},${item.name})`;
      await db`INSERT INTO canvases(id,project_id,title,target_json)
        VALUES(${item.name},${project},${item.name},${db.json(target)})`;
      await db`INSERT INTO jobs(project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES(${project},${item.name},'explore',${item.job},'{"frozen":"unchanged"}')`;
      await db`INSERT INTO project_task_queues(project_id,paused,pause_reason) VALUES(${project},${item.paused},${item.name})`;
      await db`INSERT INTO project_task_queue_items(project_id,canvas_id,state)
        VALUES(${project},${item.name},${item.state})`;
    }
    const history = await db`SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id`;
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,result)
      VALUES('system','fixture','retirement.history','ok')`;
    const audit = await db`SELECT to_jsonb(a) AS row FROM audit_logs a ORDER BY id`;
    await db`INSERT INTO events(job_id,event_id,job_seq,type,payload_json)
      SELECT id,'retirement-evidence',1,'progress','{"evidence":"original"}'::jsonb
      FROM jobs WHERE canvas_id='running'`;
    const evidence = await db`SELECT to_jsonb(e) AS row FROM events e ORDER BY id`;
    const result = await rebuildSchemaOnReservedSession(
      () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void }>,
      { force: true, dump: false, terminateScheduler: false },
    );
    assert.equal(result.applied, true);
    for (const item of cases) {
      const [canvas] = await db`SELECT target_json FROM canvases WHERE id=${item.name}`;
      assert.equal(canvas!.target_json.execution_control?.paused === true, item.expected, item.name);
      if (item.name === "task_pause") {
        assert.deepEqual(canvas!.target_json.execution_control,
          { paused: true, reason: "manual_pause", paused_by: "operator" });
      }
    }
    assert.deepEqual(await db`SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id`, history);
    assert.deepEqual(await db`SELECT to_jsonb(a) AS row FROM audit_logs a ORDER BY id`, audit);
    assert.deepEqual(await db`SELECT to_jsonb(e) AS row FROM events e ORDER BY id`, evidence);
    const [tables] = await db`SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'project_task_queue%'`;
    assert.equal(tables!.n, 0);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
}
