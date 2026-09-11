import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EVENTS_EXPORT_LIMIT,
  EVENTS_TRUNCATED_WARNING,
  EXPORT_SNAPSHOT_ISOLATION,
  applyEventsExportLimit,
  buildProjectManifest,
  projectRoleConfigCredentials,
} from "./export.js";

test("excluded credentials omit identity fields from role-config binds", () => {
  const binds = [
    { id: "cred-1", purpose: "llm", name: "prod", kind: "llm", provider: "openai" },
  ];
  assert.deepEqual(projectRoleConfigCredentials(binds, "excluded"), []);
  const metadata = projectRoleConfigCredentials(binds, "metadata");
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0]?.source_credential_id, "cred-1");
  assert.equal(metadata[0]?.name, "prod");
  assert.equal(metadata[0]?.purpose, "llm");
});

test("events export marks truncation when the limit is hit", () => {
  const limited = applyEventsExportLimit(["a", "b", "c"], 2);
  assert.deepEqual(limited.rows, ["a", "b"]);
  assert.equal(limited.truncated, true);
  assert.equal(limited.warning, EVENTS_TRUNCATED_WARNING);

  const exact = applyEventsExportLimit(["a", "b"], 2);
  assert.equal(exact.truncated, false);
  assert.equal(exact.warning, undefined);
  assert.equal(EVENTS_EXPORT_LIMIT, 100_000);
});

test("project manifest records events_truncated and warnings", () => {
  const manifest = buildProjectManifest({
    projectId: "project",
    projectName: "demo",
    preset: "evidence_archive",
    modules: ["project", "events"],
    counts: { events: EVENTS_EXPORT_LIMIT, events_truncated: true },
    credentialsMode: "excluded",
    instanceId: "test-instance",
    warnings: [EVENTS_TRUNCATED_WARNING],
  });
  assert.equal(manifest.counts.events, EVENTS_EXPORT_LIMIT);
  assert.equal(manifest.counts.events_truncated, true);
  assert.deepEqual(manifest.warnings, [EVENTS_TRUNCATED_WARNING]);
  assert.equal(manifest.secrets.mode, "excluded");
});

test("project export collects data inside a repeatable-read snapshot", () => {
  const source = readFileSync(new URL("./export.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../domains/transfer/routes.ts", import.meta.url), "utf8");
  assert.match(source, /EXPORT_SNAPSHOT_ISOLATION/);
  assert.match(source, /sql\.begin\(EXPORT_SNAPSHOT_ISOLATION/);
  assert.equal(EXPORT_SNAPSHOT_ISOLATION, "isolation level repeatable read read only");
  assert.match(source, /projectRoleConfigCredentials\(binds, credMode\)/);
  assert.match(source, /counts\.events_truncated = true/);
  assert.match(routes, /assertExportActiveJobsOption\(body\.preset, modules, body\.allow_active_jobs === true\)/);
});
