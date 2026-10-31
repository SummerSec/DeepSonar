import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export type TestSql = ReturnType<typeof postgres>;
export async function withKnowledgeDatabase(run: (db: TestSql) => Promise<void>): Promise<void> {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error("TEST_DATABASE_URL is required; refusing to use a business database");
  const url = new URL(value);
  url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const name = `deepsonar_knowledge_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const db = postgres(url.toString(), { max: 8, onnotice: () => {} });
  try {
    const connection = await db.reserve();
    try { await connection.unsafe(await readFile(new URL("../../../../../database/schema.sql", import.meta.url), "utf8")); }
    finally { connection.release(); }
    await run(db);
  } finally {
    await db.end({ timeout: 2 });
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 2 });
  }
}

export async function seedKnowledgeJob(db: TestSql, projectId?: string, tools: readonly string[] = []) {
  const project = projectId ?? randomUUID();
  await db`INSERT INTO projects(id,name) VALUES(${project}, 'knowledge fixture') ON CONFLICT DO NOTHING`;
  const id = randomUUID();
  const canvasId = randomUUID();
  const attemptId = randomUUID();
  await db`INSERT INTO canvases(id,project_id,title) VALUES(${canvasId},${project},'knowledge fixture')`;
  await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,sandbox_id,lease_expires_at,started_at)
    VALUES(${id},${project},${canvasId},'explore','running',${db.json({ platform_tools: tools })},'fixture',now()+interval '1 hour',now())`;
  await db`INSERT INTO job_attempts(id,job_id,attempt_no,phase,session_id) VALUES(${attemptId},${id},1,'agent.ready',${`session-${id}`})`;
  return { jobId: id, projectId: project, canvasId, attemptId };
}
