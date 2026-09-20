import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  evaluateSelftestEntry,
  hashesFromToolManifestBytes,
  runRuntimeImageContractSelftest,
} from "./runtime-image-contract-selftest.js";
import {
  catalogMatchesDualHash,
  coalesceToolsManifestSha256,
  toolsManifestSha256SyncChange,
  warnToolsManifestSha256Overwrite,
} from "./runtime-image-manifest-hash.js";

test("catalogMatchesDualHash accepts file-bytes OR embedded (#633)", () => {
  const expected = "11".repeat(32);
  const other = "22".repeat(32);
  assert.equal(catalogMatchesDualHash(expected, expected, other), true);
  assert.equal(catalogMatchesDualHash(expected, other, expected), true);
  assert.equal(catalogMatchesDualHash(expected, expected, expected), true);
  assert.equal(catalogMatchesDualHash(expected, other, other), false);
  assert.equal(catalogMatchesDualHash(null, expected, expected), false);
});

test("hashesFromToolManifestBytes returns file-bytes and embedded sha256", () => {
  const embedded = "ab".repeat(32);
  const body = JSON.stringify({ contract: "deepsonar.runtime.contract/v1", sha256: embedded, tools: {} });
  const bytes = Buffer.from(body, "utf8");
  const probed = hashesFromToolManifestBytes(bytes);
  assert.equal(probed.error, null);
  assert.equal(probed.embedded_sha256, embedded);
  assert.equal(probed.file_bytes_sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("evaluateSelftestEntry marks missing local images as skipped_not_local", () => {
  const item = evaluateSelftestEntry(
    {
      image_key: "deepsonar-base",
      version: "0.4.6",
      digest: "sha256:" + "11".repeat(32),
      image_ref: "ghcr.io/summersec/deepsonar-base@sha256:" + "11".repeat(32),
      catalog_sha256: "aa".repeat(32),
    },
    { exists: false, file_bytes_sha256: null, embedded_sha256: null, error: null },
  );
  assert.equal(item.status, "skipped_not_local");
  assert.equal(item.match, null);
});

test("runRuntimeImageContractSelftest dual-hash with mock probe (no docker)", async () => {
  const catalogEmbedded = "cd".repeat(32);
  const fileBytes = "ef".repeat(32);
  const result = await runRuntimeImageContractSelftest({
    listEntries: async () => [
      {
        image_key: "deepsonar-base",
        version: "0.4.6",
        digest: "sha256:" + "11".repeat(32),
        image_ref: "ghcr.io/summersec/deepsonar-base@sha256:" + "11".repeat(32),
        catalog_sha256: catalogEmbedded,
      },
      {
        image_key: "deepsonar-mobile",
        version: "0.4.6",
        digest: "sha256:" + "22".repeat(32),
        image_ref: "ghcr.io/summersec/deepsonar-mobile@sha256:" + "22".repeat(32),
        catalog_sha256: fileBytes,
      },
      {
        image_key: "deepsonar-audit",
        version: "0.4.6",
        digest: "sha256:" + "33".repeat(32),
        image_ref: "ghcr.io/summersec/deepsonar-audit@sha256:" + "33".repeat(32),
        catalog_sha256: "99".repeat(32),
      },
      {
        image_key: "deepsonar-kali-minimal",
        version: "0.4.6",
        digest: "sha256:" + "44".repeat(32),
        image_ref: "ghcr.io/summersec/deepsonar-kali-minimal@sha256:" + "44".repeat(32),
        catalog_sha256: "77".repeat(32),
      },
    ],
    probe: async (ref) => {
      if (ref.includes("deepsonar-base")) {
        return { exists: true, file_bytes_sha256: fileBytes, embedded_sha256: catalogEmbedded, error: null };
      }
      if (ref.includes("deepsonar-mobile")) {
        return { exists: true, file_bytes_sha256: fileBytes, embedded_sha256: catalogEmbedded, error: null };
      }
      if (ref.includes("deepsonar-kali")) {
        return { exists: false, file_bytes_sha256: null, embedded_sha256: null, error: null };
      }
      return { exists: true, file_bytes_sha256: "aa".repeat(32), embedded_sha256: "bb".repeat(32), error: null };
    },
  });

  assert.equal(result.results.length, 4);
  assert.equal(result.ok, false);
  assert.equal(result.results[0]!.status, "ok");
  assert.equal(result.results[0]!.match, true);
  assert.equal(result.results[1]!.status, "ok");
  assert.equal(result.results[2]!.status, "mismatch");
  assert.equal(result.results[3]!.status, "skipped_not_local");
});

test("toolsManifestSha256SyncChange detects overwrite; warn path is explicit (#636 C)", () => {
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  assert.equal(toolsManifestSha256SyncChange(a, b), "overwrite");
  assert.equal(toolsManifestSha256SyncChange(a, a), "noop");
  assert.equal(toolsManifestSha256SyncChange(null, b), "fill");
  assert.equal(toolsManifestSha256SyncChange(a, null), "preserve");
  assert.equal(coalesceToolsManifestSha256(null, a), a);
  assert.equal(coalesceToolsManifestSha256(b, a), b);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
  };
  try {
    warnToolsManifestSha256Overwrite({
      image_key: "deepsonar-base",
      digest: "sha256:" + "11".repeat(32),
      old: a,
      new: b,
      insert_only: false,
    });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /tools_manifest_sha256 overwrite/);
  assert.match(warnings[0]!, /deepsonar-base/);
});
