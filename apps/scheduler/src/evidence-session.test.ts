import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { config } from "./config.js";
import {
  JobEvidenceWriter,
  listSessionArtifacts,
  readSessionArtifact,
  SESSION_VIEW_MAX_BYTES,
} from "./evidence.js";

const JOB_ID = "00000000-0000-0000-0000-000000000188";

test("session artifacts list main and subagent, default to main, and reject unknown paths", async () => {
  const root = path.join(config.storage.blobDir, "jobs", JOB_ID);
  const writer = new JobEvidenceWriter(JOB_ID, "claude-code", "attempt-session");
  writer.setSession({
    cli: "claude-code",
    sessionId: "sess-1",
    artifacts: [
      { name: "sess-1.jsonl", sourcePath: "/tmp/sess-1.jsonl", content: '{"type":"user","message":{"role":"user","content":"main"}}\n', kind: "main" },
      { name: "subagents/child.jsonl", sourcePath: "/tmp/subagents/child.jsonl", content: '{"type":"assistant","message":{"role":"assistant","content":"sub"}}\n', kind: "subagent" },
    ],
  });
  try {
    const { manifest } = await writer.finalize();
    const artifacts = listSessionArtifacts(manifest);
    assert.deepEqual(artifacts.map((file) => [file.kind, file.name]), [
      ["main", "sess-1.jsonl"],
      ["subagent", "subagents/child.jsonl"],
    ]);

    const main = await readSessionArtifact(JOB_ID);
    assert.equal(main?.meta.kind, "main");
    assert.match(main?.content.toString("utf8") ?? "", /"main"/);
    assert.equal(main?.artifacts.length, 2);

    const child = artifacts.find((file) => file.kind === "subagent");
    assert.ok(child);
    const selected = await readSessionArtifact(JOB_ID, child.path);
    assert.equal(selected?.meta.kind, "subagent");
    assert.match(selected?.content.toString("utf8") ?? "", /"sub"/);

    assert.equal(await readSessionArtifact(JOB_ID, "attempts/attempt-session/stream.ndjson.gz"), null);
    assert.ok(SESSION_VIEW_MAX_BYTES >= 8 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default session is the last main in manifest order, not path sort", async () => {
  const laterJob = "00000000-0000-0000-0000-000000000189";
  const root = path.join(config.storage.blobDir, "jobs", laterJob);
  const older = new JobEvidenceWriter(laterJob, "claude-code", "zzz-old");
  older.setSession({
    cli: "claude-code",
    sessionId: "old",
    artifacts: [
      { name: "old.jsonl", sourcePath: "/tmp/old.jsonl", content: '{"type":"user","message":{"role":"user","content":"old"}}\n', kind: "main" },
    ],
  });
  await older.finalize();
  const newer = new JobEvidenceWriter(laterJob, "claude-code", "aaa-new");
  newer.setSession({
    cli: "claude-code",
    sessionId: "new",
    artifacts: [
      { name: "new.jsonl", sourcePath: "/tmp/new.jsonl", content: '{"type":"user","message":{"role":"user","content":"new"}}\n', kind: "main" },
    ],
  });
  try {
    await newer.finalize();
    const selected = await readSessionArtifact(laterJob);
    assert.equal(selected?.meta.name, "new.jsonl");
    assert.match(selected?.content.toString("utf8") ?? "", /"new"/);
    assert.ok(selected?.meta.path.includes("aaa-new"));
    assert.deepEqual(selected?.artifacts.map((file) => file.name), ["new.jsonl", "old.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
