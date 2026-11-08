import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseTableManifest, SCHEMA_FILE } from "../../migration-runner.js";
import { SCHEMA_VERSION } from "../../schema-version.js";

const schema = readFileSync(SCHEMA_FILE, "utf8");
const prefix = "project_finding_quality_";
const expected: Record<string, string[]> = {
  protocols: ["id", "project_id", "protocol_digest", "body_json", "created_by_actor_type", "created_by_actor_id", "created_by_actor_name", "created_at"],
  records: ["id", "project_id", "protocol_id", "kind", "record_digest", "subject_record_id", "request_key", "actor_type", "actor_id", "actor_name", "body_json", "created_at"],
  heads: ["project_id", "protocol_id", "version", "phase", "latest_record_id", "freeze_record_id", "declaration_record_id", "first_access_record_id", "dataset_record_id", "evaluation_record_id", "review_record_id", "revocation_record_id", "updated_at"],
  current: ["project_id", "version", "protocol_id", "certificate_record_id", "scope_digest", "updated_at"],
  work: ["project_id", "protocol_id", "generation", "processed_generation", "claimed_generation", "status", "dataset_record_id", "evaluation_record_id", "state_json", "last_error_code", "created_at", "updated_at"],
  observations: ["id", "project_id", "protocol_id", "work_generation", "dataset_record_id", "subject_finding_id", "ordinal", "body_json", "input_digest", "record_digest", "observed_at"],
};
function table(name: string): string {
  const start = `CREATE TABLE ${name} (`;
  const offset = schema.indexOf(start);
  assert.ok(offset >= 0, name);
  const body = schema.slice(offset + start.length);
  return body.slice(0, body.indexOf("\n);"));
}
function has(body: string, value: string): void { assert.ok(body.includes(value), value); }
const history = ["protocols", "records", "observations"];

test("quality foundation has exactly six stable tables and synchronized current schema", () => {
  assert.equal(SCHEMA_VERSION, 69);
  has(schema, `VALUES ('global', ${SCHEMA_VERSION})`);
  const manifest = parseTableManifest(schema);
  assert.deepEqual([...manifest.keys()].filter(name => name.startsWith(prefix)).sort(), Object.keys(expected).map(name => prefix + name).sort());
  for (const [name, columns] of Object.entries(expected)) {
    assert.deepEqual([...manifest.get(prefix + name) ?? []].sort(), [...columns].sort(), name);
  }
});

test("quality history rejects edits and uses enforced server receipt timestamps", () => {
  for (const name of history) {
    has(schema, `CREATE TRIGGER ${prefix + name}_immutable BEFORE INSERT OR UPDATE OR DELETE ON ${prefix + name}`);
    has(table(prefix + name), "DEFAULT clock_timestamp()");
  }
  has(schema, "IF TG_OP <> 'INSERT' THEN");
  has(schema, "RAISE EXCEPTION 'finding_quality_history_append_only'");
  has(schema, "NEW.created_at := clock_timestamp()");
  has(schema, "NEW.observed_at := clock_timestamp()");
  for (const name of ["heads", "current", "work"]) assert.ok(!schema.includes(`CREATE TRIGGER ${prefix + name}_immutable`));
  for (const column of ["phase", "frozen_at", "revoked_at", "passed"]) assert.ok(!parseTableManifest(schema).get(prefix + "protocols")?.has(column));
});

test("quality records keep immutable scoped associations and do not deduplicate exposure by digest", () => {
  const records = table(prefix + "records");
  has(records, "FOREIGN KEY (protocol_id, project_id) REFERENCES project_finding_quality_protocols(id, project_id)");
  has(records, "FOREIGN KEY (subject_record_id, project_id, protocol_id) REFERENCES project_finding_quality_records(id, project_id, protocol_id)");
  has(records, "UNIQUE (id, project_id, protocol_id)");
  has(records, "UNIQUE (project_id, protocol_id, kind, request_key)");
  assert.ok(!records.includes("UNIQUE (record_digest"));
  assert.ok(!records.includes("UNIQUE (project_id, protocol_id, record_digest"));
  const kinds = ["registered", "freeze", "dataset_declaration", "holdout_access", "holdout_payload", "dataset_admission", "evaluation", "review", "revoke", "rejection", "alias_resolution"];
  for (const kind of kinds) has(records, `'${kind}'`);
  for (const name of ["protocols", "records"]) {
    const body = table(prefix + name);
    for (const type of ["bootstrap_admin", "api_token", "user", "internal"]) has(body, `'${type}'`);
    has(body, "BETWEEN 1 AND 200");
    has(body, name === "records" ? "actor_id IS NULL" : "created_by_actor_id IS NULL");
  }
});

test("quality heads/current certificates use scoped FKs and explicit nullable-deny guards", () => {
  const heads = table(prefix + "heads");
  for (const pointer of ["latest_record_id", "freeze_record_id", "declaration_record_id", "first_access_record_id", "dataset_record_id", "evaluation_record_id", "review_record_id", "revocation_record_id"]) {
    has(heads, `FOREIGN KEY (${pointer}, project_id, protocol_id) REFERENCES project_finding_quality_records(id, project_id, protocol_id)`);
  }
  has(heads, "latest_record_id uuid NOT NULL");
  has(heads, "phase NOT IN ('frozen', 'admitted', 'evaluated', 'reviewed') OR freeze_record_id IS NOT NULL");
  has(heads, "first_access_record_id IS NOT NULL AND dataset_record_id IS NOT NULL");
  has(heads, "OR evaluation_record_id IS NOT NULL");
  has(heads, "phase <> 'reviewed' OR review_record_id IS NOT NULL");
  has(heads, "phase <> 'revoked' OR revocation_record_id IS NOT NULL");
  const current = table(prefix + "current");
  has(current, "protocol_id IS NULL AND certificate_record_id IS NULL AND scope_digest IS NULL");
  has(current, "protocol_id IS NOT NULL AND certificate_record_id IS NOT NULL AND scope_digest IS NOT NULL");
  has(current, "FOREIGN KEY (certificate_record_id, project_id, protocol_id) REFERENCES project_finding_quality_records(id, project_id, protocol_id)");
  has(current, "version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)");
});

test("quality object byte caps and generation fences are engineering bounds, not quality thresholds", () => {
  for (const [name, column, bytes] of [["protocols", "body_json", 65536], ["records", "body_json", 16777216], ["work", "state_json", 16384], ["observations", "body_json", 262144]] as const) {
    const body = table(prefix + name);
    has(body, `jsonb_typeof(${column}) = 'object'`);
    has(body, `octet_length(${column}::text) <= ${bytes}`);
  }
  const work = table(prefix + "work");
  has(work, "generation >= 1");
  has(work, "processed_generation >= 0 AND processed_generation <= generation");
  has(work, "claimed_generation IS NULL OR claimed_generation BETWEEN 1 AND generation");
  for (const pointer of ["dataset_record_id", "evaluation_record_id"]) has(work, `FOREIGN KEY (${pointer}, project_id, protocol_id) REFERENCES project_finding_quality_records(id, project_id, protocol_id)`);
  const observations = table(prefix + "observations");
  has(observations, "FOREIGN KEY (project_id, protocol_id) REFERENCES project_finding_quality_work(project_id, protocol_id)");
  has(observations, "FOREIGN KEY (project_id, subject_finding_id) REFERENCES findings(project_id, id)");
  has(observations, "UNIQUE (protocol_id, work_generation, subject_finding_id)");
  has(observations, "UNIQUE (protocol_id, work_generation, ordinal)");
  // Human labels live in sealed immutable records, never observation columns.
  for (const field of ["labels", "label", "job_id", "executor_id"]) assert.ok(!parseTableManifest(schema).get(prefix + "observations")?.has(field));
});

test("relation publication cannot be unlocked by Boolean/status flips or partial certificate tuples", () => {
  const body = table("project_finding_relations");
  has(body, "quality_gate_status text NOT NULL DEFAULT 'not_evaluated'");
  has(body, "published boolean NOT NULL DEFAULT false,");
  has(body, "quality_protocol_id IS NULL AND quality_certificate_record_id IS NULL AND quality_scope_digest IS NULL");
  has(body, "quality_protocol_id IS NOT NULL AND quality_certificate_record_id IS NOT NULL AND quality_scope_digest IS NOT NULL");
  has(body, "quality_gate_status <> 'passed' OR (");
  has(body, "NOT published OR (quality_gate_status = 'passed' AND quality_protocol_id IS NOT NULL");
  has(body, "FOREIGN KEY (quality_certificate_record_id, project_id, quality_protocol_id) REFERENCES project_finding_quality_records(id, project_id, protocol_id)");
  has(body, "quality_scope_digest ~ '^sha256:[a-f0-9]{64}$'");
  assert.ok(!body.includes("CHECK (published = false)"));
});
