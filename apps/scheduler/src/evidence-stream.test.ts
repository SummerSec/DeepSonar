import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import test from "node:test";
import {
  JobEvidenceWriter,
  MAX_STREAM_RETAINED_BYTES,
  appendOtlpEnvelope,
  clearJobEvidenceSecrets,
  parseStreamFile,
  readGzipTail,
  readNormalizedStream,
  readNormalizedStreamPage,
  registerJobEvidenceSecrets,
} from "./evidence.js";
import { config } from "./config.js";
import { encodeCursor } from "./pagination.js";

const gzipP = promisify(gzip);
const gunzipP = promisify(gunzip);

test("runtime capability secrets are redacted from normalized and OTLP evidence", async () => {
  const jobId = "00000000-0000-0000-0000-000000000091";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  const secret = "deepsonarcap_deadbeef_exact-runtime-secret-value";
  const writer = new JobEvidenceWriter(jobId, "test", "attempt-secret");
  registerJobEvidenceSecrets(jobId, [secret]);
  try {
    await writer.appendNormalized({ type: "text.delta", delta: `leak=${secret}` });
    await appendOtlpEnvelope(jobId, "logs", "application/json", { body: `Bearer ${secret}` });
    const { manifest } = await writer.finalize();
    const contents = await Promise.all(manifest.files.map(async (file) => {
      const raw = await readFile(path.join(root, file.path));
      return file.path.endsWith(".gz") ? (await gunzipP(raw)).toString("utf8") : raw.toString("utf8");
    }));
    assert.equal(contents.some((content) => content.includes(secret)), false);
    assert.equal(contents.some((content) => content.includes("[REDACTED]")), true);
  } finally {
    clearJobEvidenceSecrets(jobId);
    await rm(root, { recursive: true, force: true });
  }
});

test("gzip evidence tail stops at decompression budget instead of inflating a bomb", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deepsonar-evidence-"));
  const archive = path.join(dir, "stream.ndjson.gz");
  try {
    const compressed = await gzipP(Buffer.alloc(65 * 1024 * 1024, 0x78));
    await writeFile(archive, compressed);
    const result = await readGzipTail(archive);
    assert.equal(result.truncated, true);
    assert.ok(result.raw.byteLength <= 8 * 1024 * 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw tail alignment is trimmed exactly once so the first complete record survives", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deepsonar-evidence-"));
  const archive = path.join(dir, "stream.ndjson");
  const max = 8 * 1024 * 1024;
  const first = `${JSON.stringify({ attempt_id: "attempt", seq: 1, type: "text.delta", delta: "first" })}\n`;
  const second = `${JSON.stringify({ attempt_id: "attempt", seq: 2, type: "text.delta", delta: "second" })}\n`;
  try {
    await writeFile(archive, Buffer.concat([
      Buffer.alloc(max - 500, 0x78),
      Buffer.from(first),
      Buffer.from(second),
      Buffer.alloc(1000, 0x79),
    ]));
    const parsed = await parseStreamFile(archive, "attempt", false);
    assert.ok(parsed.records.some((record) => record.seq === 2), "first aligned record should remain visible");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalized stream publication can wait for delayed evidence persistence", async () => {
  const jobId = "00000000-0000-0000-0000-000000000099";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const writer = new JobEvidenceWriter(jobId, "test", "attempt-delay");
  (writer as unknown as { queue: Promise<void> }).queue = delayed;
  let published = false;
  const persisted = writer.appendNormalized({ type: "text.delta", delta: "delayed" }).then(() => { published = true; });
  await Promise.resolve();
  assert.equal(published, false);
  release();
  await persisted;
  assert.equal(published, true);
  const streamPath = path.join(root, "attempts", "attempt-delay", "stream.ndjson");
  assert.match((await readFile(streamPath, "utf8")), /"seq":1/);
  await rm(root, { recursive: true, force: true });
});

test("evidence request applies a total decompression budget across archives", async () => {
  const jobId = "00000000-0000-0000-0000-000000000098";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  try {
    const files = ["attempt-a", "attempt-b"];
    for (const attempt of files) {
      const dir = path.join(root, "attempts", attempt);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "stream.ndjson.gz"), await gzipP(Buffer.alloc(64 * 1024 * 1024, 0x78)));
    }
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      v: 1,
      job_id: jobId,
      cli: "test",
      session_id: null,
      created_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      files: files.map((attempt) => ({
        name: attempt,
        path: `attempts/${attempt}/stream.ndjson.gz`,
        kind: "stream",
        bytes: 1,
        sha256: "",
      })),
    }));
    const result = await readNormalizedStreamPage(jobId, { limit: 1 });
    assert.equal(result.truncated, true);
    assert.equal(result.gap, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tail prioritizes the current raw attempt over an exhausted archive budget", async () => {
  const jobId = "00000000-0000-0000-0000-000000000097";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  const attempts = Array.from({ length: 32 }, (_, index) => `archive-${String(index).padStart(2, "0")}`);
  try {
    const files = [];
    for (const [index, attempt] of attempts.entries()) {
      const dir = path.join(root, "attempts", attempt);
      await mkdir(dir, { recursive: true });
      const streamPath = path.join(dir, "stream.ndjson.gz");
      await writeFile(streamPath, await gzipP(Buffer.from(JSON.stringify({ attempt_id: attempt, seq: 1, at: index + 1 }) + "\n")));
      files.push({
        name: attempt,
        path: `attempts/${attempt}/stream.ndjson.gz`,
        kind: "stream" as const,
        bytes: 1,
        sha256: "",
      });
    }
    const current = path.join(root, "attempts", "attempt-current");
    await mkdir(current, { recursive: true });
    await writeFile(
      path.join(current, "stream.ndjson"),
      `${JSON.stringify({ attempt_id: "attempt-current", seq: 1, at: 1000 })}\n`,
    );
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      v: 1,
      job_id: jobId,
      cli: "test",
      session_id: null,
      created_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      files,
    }));

    const result = await readNormalizedStreamPage(jobId, { tail: true, limit: 1 });
    assert.equal(result.items[0]?.attempt_id, "attempt-current");
    assert.equal(result.truncated, true);
    assert.equal(result.gap, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor attempts beyond early archives are read before the archive budget is spent", async () => {
  const jobId = "00000000-0000-0000-0000-000000000096";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  const attempts = Array.from({ length: 32 }, (_, index) => `archive-${String(index).padStart(2, "0")}`);
  try {
    const files = [];
    for (const [index, attempt] of attempts.entries()) {
      const dir = path.join(root, "attempts", attempt);
      await mkdir(dir, { recursive: true });
      const streamPath = path.join(dir, "stream.ndjson.gz");
      await writeFile(streamPath, await gzipP(Buffer.from(JSON.stringify({ attempt_id: attempt, seq: 1, at: index + 1 }) + "\n")));
      files.push({
        name: attempt,
        path: `attempts/${attempt}/stream.ndjson.gz`,
        kind: "stream" as const,
        bytes: 1,
        sha256: "",
      });
    }
    const current = path.join(root, "attempts", "attempt-current");
    await mkdir(current, { recursive: true });
    await writeFile(
      path.join(current, "stream.ndjson"),
      `${JSON.stringify({ attempt_id: "attempt-current", seq: 1, at: 1000 })}\n${JSON.stringify({ attempt_id: "attempt-current", seq: 2, at: 1001 })}\n`,
    );
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      v: 1,
      job_id: jobId,
      cli: "test",
      session_id: null,
      created_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      files,
    }));

    const result = await readNormalizedStreamPage(jobId, {
      after: encodeCursor({ kind: "stream", attempt_id: "attempt-current", seq: 1 }),
      limit: 1,
    });
    assert.equal(result.items[0]?.attempt_id, "attempt-current");
    assert.equal(result.items[0]?.seq, 2);
    assert.equal(result.gap, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained records stay byte-bounded while tail and cursor prioritize current attempts", async () => {
  const jobId = "00000000-0000-0000-0000-000000000095";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  const attempts = ["archive-a", "archive-b", "archive-c"];
  const payload = "x".repeat(240 * 1024);
  try {
    const files = [];
    for (const [index, attempt] of attempts.entries()) {
      const dir = path.join(root, "attempts", attempt);
      await mkdir(dir, { recursive: true });
      const lines = Array.from({ length: 30 }, (_, seq) => JSON.stringify({
        attempt_id: attempt,
        seq: seq + 1,
        at: index + 1,
        payload,
      })).join("\n") + "\n";
      const streamPath = path.join(dir, "stream.ndjson.gz");
      await writeFile(streamPath, await gzipP(Buffer.from(lines)));
      files.push({
        name: attempt,
        path: `attempts/${attempt}/stream.ndjson.gz`,
        kind: "stream" as const,
        bytes: Buffer.byteLength(lines),
        sha256: "",
      });
    }
    const current = path.join(root, "attempts", "attempt-current");
    await mkdir(current, { recursive: true });
    await writeFile(
      path.join(current, "stream.ndjson"),
      `${JSON.stringify({ attempt_id: "attempt-current", seq: 1, at: 1000, payload: "current" })}\n${JSON.stringify({ attempt_id: "attempt-current", seq: 2, at: 1001, payload: "current-next" })}\n`,
    );
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      v: 1,
      job_id: jobId,
      cli: "test",
      session_id: null,
      created_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      files,
    }));

    const retained = await readNormalizedStream(jobId, { tail: true });
    const retainedBytes = retained.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"), 0);
    assert.ok(retainedBytes <= MAX_STREAM_RETAINED_BYTES);
    assert.ok(retained.some((record) => record.attempt_id === "attempt-current"));

    const after = encodeCursor({ kind: "stream", attempt_id: "attempt-current", seq: 1 });
    const cursorPage = await readNormalizedStreamPage(jobId, { after, limit: 1 });
    assert.equal(cursorPage.items[0]?.attempt_id, "attempt-current");
    assert.equal(cursorPage.items[0]?.seq, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tail keeps the newest records when one file exceeds the record cap", async () => {
  const jobId = "00000000-0000-0000-0000-000000000094";
  const root = path.join(config.storage.blobDir, "jobs", jobId);
  const attempt = "attempt-many";
  try {
    const dir = path.join(root, "attempts", attempt);
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: 20_050 }, (_, index) => JSON.stringify({
      attempt_id: attempt,
      seq: index + 1,
      at: index + 1,
      type: "text.delta",
    })).join("\n") + "\n";
    await writeFile(path.join(dir, "stream.ndjson"), lines);

    const tail = await readNormalizedStreamPage(jobId, { tail: true, limit: 1 });
    assert.equal(tail.items[0]?.seq, 20_050);
    assert.equal(tail.truncated, true);
    assert.equal(tail.gap, true);

    const cursor = encodeCursor({ kind: "stream", attempt_id: attempt, seq: 20_040 });
    const suffix = await readNormalizedStreamPage(jobId, { after: cursor, limit: 1 });
    assert.equal(suffix.items[0]?.seq, 20_041);
    assert.equal(suffix.truncated, undefined);
    assert.equal(suffix.gap, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
