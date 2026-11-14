import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SCAN_SWEEP_STALE_MS, isScanSweepCandidate, sweepScanVolume,
} from "./scan-volume-hygiene.js";

const SCAN_ID = "2f6b1e7c-0a3d-4a1e-8d5f-111122223333";
const OLD = new Date(Date.now() - DEFAULT_SCAN_SWEEP_STALE_MS - 60_000);

async function seed(dir: string, name: string, bytes: string, mtime?: Date): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

test("sweep removes stale export temps and stale archives, keeps everything else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scan-sweep-"));
  try {
    await seed(dir, ".tmp-1111aaaa-bbbb-cccc-dddd-eeeeffff0000.tar1746168890", "x".repeat(64), OLD);
    await seed(dir, `${SCAN_ID}.tar`, "y".repeat(128), OLD);
    await seed(dir, ".tmp-2222aaaa-bbbb-cccc-dddd-eeeeffff0000.tar3269233833", "live", new Date());
    await seed(dir, "99999999-8888-7777-6666-555544443333.tar", "live", new Date());
    await seed(dir, "scan.log", "keep".repeat(100), OLD);
    await seed(dir, "not-a-uuid.tar", "keep", OLD);
    await mkdir(join(dir, `${SCAN_ID}.tar.d`));
    const result = await sweepScanVolume(dir, { now: Date.now() });
    assert.equal(result.removed, 2, "only the stale temp file and stale archive are removed");
    assert.equal(result.bytes, 64 + 128);
    assert.equal(result.failed, 0);
    const { readdir } = await import("node:fs/promises");
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [
      "99999999-8888-7777-6666-555544443333.tar",
      `${SCAN_ID}.tar.d`,
      ".tmp-2222aaaa-bbbb-cccc-dddd-eeeeffff0000.tar3269233833",
      "not-a-uuid.tar",
      "scan.log",
    ].sort(), "fresh candidates, unrelated names and directories survive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweep treats a missing volume as empty and tolerates disappearing entries", async () => {
  const missing = await sweepScanVolume(join(tmpdir(), "scan-sweep-absent-volume"));
  assert.deepEqual(missing, { removed: 0, bytes: 0, skipped: 0, failed: 0 });
  const dir = await mkdtemp(join(tmpdir(), "scan-sweep-io-"));
  try {
    const vanished = join(dir, `${SCAN_ID}.tar`);
    await seed(dir, `${SCAN_ID}.tar`, "gone", OLD);
    const result = await sweepScanVolume(dir, {
      io: {
        readdir: async () => [`${SCAN_ID}.tar`],
        lstat: async () => ({ isFile: () => true, mtimeMs: OLD.getTime(), size: 4 }),
        unlink: async (path: string) => { assert.equal(path, vanished); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      },
    });
    assert.equal(result.removed, 0);
    assert.equal(result.failed, 1, "disappearing entries are counted, never thrown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate shapes stay narrow: only CLI temps and uuid archives qualify", () => {
  assert.equal(isScanSweepCandidate(".tmp-abc.tar123"), true);
  assert.equal(isScanSweepCandidate(`${SCAN_ID}.tar`), true);
  assert.equal(isScanSweepCandidate("scan.log"), false);
  assert.equal(isScanSweepCandidate(".tmp"), false);
  assert.equal(isScanSweepCandidate(`${SCAN_ID}.tar.gz`), false);
  assert.equal(isScanSweepCandidate(`prefix-${SCAN_ID}.tar`), false);
});
