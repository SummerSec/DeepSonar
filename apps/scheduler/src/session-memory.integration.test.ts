import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlanExecutionFixture } from "./plan-execution-test-fixture.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("historical Pi session preview/download redact before truncation and preserve immutable source bytes", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    const { JobEvidenceWriter, SESSION_VIEW_MAX_BYTES } = await import("./evidence.js");
    const f = await h.fixture();
    const canary = "HISTORICAL_OM_PRIVATE_CANARY";
    const secretMemory = canary.repeat(Math.ceil((SESSION_VIEW_MAX_BYTES + 4096) / canary.length));
    const source = Buffer.from([
      JSON.stringify({ type: "session", version: 3, id: "historical-pi", timestamp: "2026-10-31T00:00:00Z", cwd: "/workspace" }),
      JSON.stringify({ type: "custom", id: "memory-entry", parentId: null, timestamp: "2026-10-31T00:00:01Z",
        customType: "om.observations.recorded", data: { coversUpToId: "source-entry", observations: [{
          id: "012345abcdef", timestamp: "2026-10-31 00:00", relevance: "high", content: secretMemory,
          sourceEntryIds: ["source-entry"], tokenCount: 42,
        }] } }),
      JSON.stringify({ type: "message", id: "ordinary-entry", message: { role: "assistant", content: [{ type: "text", text: "Ordinary output remains visible" }] } }),
    ].join("\n") + "\n");
    assert.ok(source.byteLength > SESSION_VIEW_MAX_BYTES);
    // Historical mixed-CLI manifests can describe the newest CLI while an
    // explicitly selected earlier archive still has its own Pi header.
    await h.sql`UPDATE jobs SET agent_snapshot_json=agent_snapshot_json || ${h.sql.json({ agent_cli: "claude-code" })} WHERE id=${f.hub}`;
    const writer = new JobEvidenceWriter(f.hub, "claude-code", "historical-session");
    writer.setSession({ cli: "claude-code", sessionId: "later-cli", artifacts: [{
      name: "historical-pi.jsonl", sourcePath: "/tmp/historical-pi.jsonl", kind: "main", content: source.toString("utf8"),
    }] });
    const { manifest } = await writer.finalize();
    const meta = manifest.files.find((file) => file.kind === "main")!;
    const sourcePath = path.join(h.blob, "jobs", f.hub, meta.path);
    assert.equal(digest(await readFile(sourcePath)), digest(source));

    const preview = await h.app.inject({ method: "GET", url: `/jobs/${f.hub}/evidence/session` });
    assert.equal(preview.statusCode, 200, preview.payload);
    const view = preview.json();
    assert.doesNotMatch(view.text, new RegExp(canary));
    assert.match(view.text, /Ordinary output remains visible/);
    assert.equal(view.truncated, false, "redaction must happen on the complete record before the preview byte limit");
    assert.equal(view.meta.sha256, digest(source));
    assert.equal(view.projection.kind, "pi-memory-redacted");

    const download = await h.app.inject({ method: "GET", url: `/jobs/${f.hub}/evidence/session/download?path=${encodeURIComponent(meta.path)}` });
    assert.equal(download.statusCode, 200, download.payload);
    assert.doesNotMatch(download.payload, new RegExp(canary));
    assert.equal(download.headers["x-deepsonar-session-projection"], "pi-memory-redacted");
    assert.equal(download.headers["content-digest"], `sha-256=:${createHash("sha256").update(download.rawPayload).digest("base64")}:`);
    assert.equal(digest(download.rawPayload), view.projection.sha256);
    assert.equal(download.rawPayload.byteLength, view.projection.bytes);
    assert.deepEqual(await readFile(sourcePath), source, "read projection cannot rewrite immutable archive bytes");
    const missing = await h.app.inject({ method: "GET", url: `/jobs/${f.hub}/evidence/session/download?path=${encodeURIComponent("../outside.jsonl")}` });
    assert.equal(missing.statusCode, 404);

    const native = await h.fixture();
    const quotedExample = JSON.stringify({ customType: "om.observations.recorded", data: { content: "ordinary quoted code example" } });
    const nativeContent = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: quotedExample }] } }) + "\n";
    const nativeWriter = new JobEvidenceWriter(native.hub, "claude-code", "native-session");
    nativeWriter.setSession({ cli: "claude-code", sessionId: "native", artifacts: [{ name: "native.jsonl", sourcePath: "/tmp/native.jsonl", kind: "main", content: nativeContent }] });
    await nativeWriter.finalize();
    const nativeDownload = await h.app.inject({ method: "GET", url: `/jobs/${native.hub}/evidence/session/download` });
    assert.equal(nativeDownload.statusCode, 200);
    assert.equal(nativeDownload.payload, nativeContent, "other CLI sessions retain their ordinary quoted input exactly");
    assert.equal(nativeDownload.headers["x-deepsonar-session-projection"], undefined);
  } finally { await h.close(); }
});
