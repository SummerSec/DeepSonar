import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LocalBlobStore,
  assertSharedAssetBlobUri,
  objectKeyFor,
  parseBlobStoreKind,
  sharedAssetBlobUri,
} from "./index.js";

test("shared asset blob uri is CAS path", () => {
  const sha = "a".repeat(64);
  assert.equal(sharedAssetBlobUri(sha), `shared-assets/sha256/aa/${sha}`);
  assert.equal(assertSharedAssetBlobUri(`shared-assets/sha256/aa/${sha}`), `shared-assets/sha256/aa/${sha}`);
  assert.throws(() => sharedAssetBlobUri("not-a-hash"), /invalid_asset_blob_sha256/);
  assert.throws(() => assertSharedAssetBlobUri("shared-assets/sha256/bb/" + "a".repeat(64)), /invalid_asset_blob_uri/);
  assert.throws(() => assertSharedAssetBlobUri("../etc/passwd"), /invalid_asset_blob_uri/);
});

test("objectKeyFor applies optional prefix", () => {
  const sha = "b".repeat(64);
  const uri = sharedAssetBlobUri(sha);
  assert.equal(objectKeyFor("", uri), uri);
  assert.equal(objectKeyFor("deepsonar/blobs", uri), `deepsonar/blobs/${uri}`);
  assert.equal(objectKeyFor("/deepsonar/blobs/", uri), `deepsonar/blobs/${uri}`);
});

test("parseBlobStoreKind accepts fs/s3 aliases", () => {
  assert.equal(parseBlobStoreKind(undefined), "fs");
  assert.equal(parseBlobStoreKind("fs"), "fs");
  assert.equal(parseBlobStoreKind("local"), "fs");
  assert.equal(parseBlobStoreKind("S3"), "s3");
  assert.equal(parseBlobStoreKind("minio"), "s3");
  assert.throws(() => parseBlobStoreKind("nfs"), /unsupported_blob_store/);
});

test("LocalBlobStore put/get/exists/materialize", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-blob-"));
  try {
    const store = new LocalBlobStore(root);
    const bytes = Buffer.from("hello-shared-asset");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = sharedAssetBlobUri(sha);

    assert.equal(await store.exists(key), false);
    await store.put(key, bytes, { contentType: "text/plain" });
    assert.equal(await store.exists(key), true);
    assert.deepEqual(await store.get(key), bytes);
    // Idempotent put of identical CAS content.
    await store.put(key, bytes);
    const local = await store.materializeLocal(key);
    assert.equal(path.normalize(local), path.normalize(path.join(root, ...key.split("/"))));
    assert.deepEqual(await store.get(key), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalBlobStore rejects path escape keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-blob-"));
  try {
    const store = new LocalBlobStore(root);
    await assert.rejects(() => store.get("shared-assets/../secret"), /invalid_asset_blob_uri/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
