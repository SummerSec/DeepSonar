import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { config } from "../../config.js";
import { captureCheckpointFiles, checkpointHash, HumanCheckpointManifest, putCheckpointFile, readCheckpointFile,
  HUMAN_CHECKPOINT_FILE_BYTES } from "./human-checkpoint-files.js";

test("structured checkpoints reject unsafe paths, duplicate names and excessive bytes", () => {
  const manifest = { v: 1, job_id: randomUUID(), attempt_id: randomUUID(), request_id: randomUUID(),
    snapshot_sha256: "a".repeat(64), mode: "structured", files: [] as unknown[] };
  const file = { path: "src/work.txt", bytes: 1, sha256: "b".repeat(64) };
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [file] }).success, true);
  for (const filePath of ["/etc/passwd", "../escape", "a/../escape", "a\\b", ".deepsonar/inbox/x", ".ssh/id_rsa",
    ".claude/config.json", ".pi/auth.json", "config/.env.local", "tokens.json", "a\0b", "C:/escape"]) {
    assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [{ ...file, path: filePath }] }).success, false, filePath);
  }
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [file, file] }).success, false);
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [{ ...file, bytes: HUMAN_CHECKPOINT_FILE_BYTES + 1 }] }).success, false);
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest,
    files: Array.from({ length: 9 }, (_, index) => ({ ...file, path: `file-${index}`, bytes: HUMAN_CHECKPOINT_FILE_BYTES })) }).success, false);
});

test("capture checks source hashes and secrets; reads reject corruption and missing local storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "human-checkpoint-"));
  const previous = config.storage.blobDir;
  Reflect.set(config.storage, "blobDir", directory);
  const requestId = randomUUID(), bytes = Buffer.from("retained work\0\xff"), filePath = "src/result.bin";
  const host = { run: async () => ({ exitCode: 0, stdout: JSON.stringify([
    { path: filePath, bytes: bytes.length, sha256: checkpointHash(bytes) }]), stderr: "" }),
    readWorkspaceFile: async (requested: string) => { assert.equal(requested, `/workspace/${filePath}`); return bytes; },
  } as unknown as RuntimeHost;
  try {
    const files = await captureCheckpointFiles(host, requestId, [], [], []);
    assert.equal(files.length, 1);
    assert.deepEqual(await readCheckpointFile(requestId, files[0]), bytes);
    await assert.rejects(captureCheckpointFiles(host, randomUUID(), [], ["retained"], []), /SECRET_DETECTED/);
    const changed = { ...host, readWorkspaceFile: async () => Buffer.alloc(bytes.length) };
    await assert.rejects(captureCheckpointFiles(changed, randomUUID(), [], [], []), /FILE_CHANGED/);
    const hostile = { ...host, run: async () => ({ exitCode: 0, stdout: JSON.stringify([
      { path: "../escape", bytes: 1, sha256: "a".repeat(64) }]), stderr: "" }) };
    await assert.rejects(captureCheckpointFiles(hostile, randomUUID(), [], [], []));
    const stored = await putCheckpointFile(requestId, bytes);
    await writeFile(path.join(directory, "human-checkpoints", requestId, stored.sha256), Buffer.alloc(bytes.length));
    await assert.rejects(readCheckpointFile(requestId, stored), /HASH_MISMATCH/);
    await assert.rejects(readCheckpointFile(randomUUID(), stored), /FILE_UNAVAILABLE/);
  } finally { Reflect.set(config.storage, "blobDir", previous); await rm(directory, { recursive: true, force: true }); }
});
