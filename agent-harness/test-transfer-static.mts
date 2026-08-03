/** Non-live transfer contract smoke.  It never imports the database client or calls localhost. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CANVAS_BROADCASTS_FILE,
  broadcastNaturalKey,
  sanitizeBroadcastText,
  validateCanvasBroadcastRows,
} from "../apps/scheduler/src/transfer/broadcasts.js";
import { resolveModules } from "../apps/scheduler/src/transfer/modules.js";
import { openDeepsonarPack, writeDeepsonarPack, type Manifest } from "../apps/scheduler/src/transfer/pack.js";

const refs = {
  canvases: [{ source_id: "canvas-1" }],
  jobs: [
    { source_id: "source-job", source_canvas_id: "canvas-1" },
    { source_id: "target-job", source_canvas_id: "canvas-1" },
  ],
  nodes: [{ source_id: "fact-1", source_canvas_id: "canvas-1", source_job_id: "source-job", node_type: "fact" }],
};

const validRow = {
  source_id: "broadcast-1",
  source_canvas_id: "canvas-1",
  source_job_id: "source-job",
  source_node_id: "fact-1",
  source_node_type: "fact",
  target_job_id: "target-job",
  target_role: "audit",
  target_role_kind: "role",
  attempt: 1,
  delivery_status: "injected",
  skip_reason: null,
  error_code: null,
  error_message: "safe",
  title: "fact title",
  payload_preview: "Authorization: Bearer should-not-leak",
  payload_sha256: "a".repeat(64),
  message_chars: 42,
  injected_at: "2026-08-03T00:00:01.000Z",
  finished_at: "2026-08-03T00:00:02.000Z",
  decision_deadline_at: "2026-08-03T00:01:00.000Z",
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:02.000Z",
};

const full = resolveModules("project_full").modules;
const archive = resolveModules("evidence_archive").modules;
const config = resolveModules("configuration").modules;
const custom = resolveModules("custom", ["canvas_broadcasts"]);
assert(full.includes("canvas_broadcasts"));
assert(archive.includes("canvas_broadcasts"));
assert(!config.includes("canvas_broadcasts"));
assert(custom.modules.includes("canvas_broadcasts") && custom.modules.includes("tasks"));
assert(custom.autoAdded.includes("tasks"));

const rows = validateCanvasBroadcastRows([validRow], refs.canvases, refs.jobs, refs.nodes);
assert.equal(rows.length, 1);
assert.equal(broadcastNaturalKey(rows[0]), "fact-1\u0000target-job\u00001");
assert(!rows[0].payload_preview?.includes("should-not-leak"));
assert(sanitizeBroadcastText("token=secret-value", 100)?.includes("[REDACTED]"));

assert.throws(
  () => validateCanvasBroadcastRows([validRow, { ...validRow, source_id: "broadcast-2" }], refs.canvases, refs.jobs, refs.nodes),
  /DUPLICATE_BROADCAST_KEY|自然键/,
);
assert.throws(
  () => validateCanvasBroadcastRows([{ ...validRow, source_node_id: "missing-node" }], refs.canvases, refs.jobs, refs.nodes),
  /BROADCAST_REF_MISSING|缺少/,
);

const temp = await mkdtemp(path.join(os.tmpdir(), "deepsonar-transfer-static-"));
try {
  const manifest: Manifest = {
    format: "deepsonar-project-export",
    format_version: "1.0",
    created_at: "2026-08-03T00:00:00.000Z",
    source: {
      app_version: "static-smoke",
      schema_version: 1,
      instance_id: "sha256:static",
      project_id: "project-1",
      project_name: "static",
    },
    preset: "custom",
    modules: ["project", "tasks", "canvas_broadcasts"],
    counts: { canvas_broadcasts: 1 },
    compatibility: { minimum_importer_version: "1.0", module_versions: { canvas_broadcasts: 1 } },
    secrets: { mode: "excluded", algorithm: null },
    signature: null,
  };
  const packed = path.join(temp, "roundtrip.deepsonarpack");
  await writeDeepsonarPack(
    [{ path: CANVAS_BROADCASTS_FILE, content: JSON.stringify(rows[0]) + "\n" }],
    manifest,
    packed,
  );
  const opened = await openDeepsonarPack(await (await import("node:fs/promises")).readFile(packed));
  assert(opened.files.has(CANVAS_BROADCASTS_FILE));
  assert.equal(opened.manifest.content_sha256?.length, 64);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, smoke: "transfer-static", modules: full.length }));
