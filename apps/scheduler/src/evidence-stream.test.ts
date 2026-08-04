import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import test from "node:test";
import { readGzipTail } from "./evidence.js";

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
