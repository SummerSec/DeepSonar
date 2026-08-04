import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import test from "node:test";
import { JobEvidenceWriter, parseStreamFile, readGzipTail, readNormalizedStreamPage } from "./evidence.js";
import { config } from "./config.js";

const gzipP = promisify(gzip);

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
