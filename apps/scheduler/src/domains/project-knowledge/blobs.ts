import { getSharedAssetBlobStore, sharedAssetBlobUri } from "../../blob-store/index.js";
import { KnowledgeCandidate, KNOWLEDGE_LIMITS, type KnowledgeCandidate as Candidate } from "@deepsonar/shared-types";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";

export async function writeKnowledgeBlob(db: KnowledgeDb, value: unknown): Promise<{ hash: string; bytes: number }> {
  const buffer = Buffer.from(canonical(value), "utf8");
  const hash = sha256(buffer);
  const uri = sharedAssetBlobUri(hash);
  const store = getSharedAssetBlobStore();
  if (!(await store.exists(uri))) await store.put(uri, buffer, { contentType: "application/json" });
  // Metadata is deliberately inserted in the domain transaction, after CAS is durable.
  return { hash, bytes: buffer.length };
}

export async function registerKnowledgeBlob(tx: KnowledgeDb, hash: string, bytes: number): Promise<void> {
  await tx`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
    VALUES(${hash},${bytes},'application/json',${sharedAssetBlobUri(hash)}) ON CONFLICT(content_sha256) DO NOTHING`;
}

export async function readKnowledgeBlob(db: KnowledgeDb, hash: string): Promise<unknown> {
  const [row] = await db`SELECT blob_uri,bytes FROM shared_asset_blobs WHERE content_sha256=${hash}`;
  if (!row) return reject("KNOWLEDGE_SOURCE_MISSING", "Knowledge content is unavailable");
  if (!Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) < 0 || Number(row.bytes) > KNOWLEDGE_LIMITS.bundleBytes * 3)
    return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Knowledge content exceeds the bounded CAS read budget");
  const bytes = await getSharedAssetBlobStore().get(String(row.blob_uri));
  if (bytes.length !== Number(row.bytes) || sha256(bytes) !== hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Knowledge content hash mismatch");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

/** Version CAS bytes are canonical JSON of the complete KnowledgeCandidate. */
export async function readKnowledgeVersionContent(db: KnowledgeDb, versionId: string): Promise<Candidate> {
  const [row] = await db`SELECT content_sha256,revoked_at FROM project_knowledge_versions WHERE id=${versionId}`;
  if (!row || row.revoked_at) return reject("KNOWLEDGE_REVOKED", "Knowledge version is unavailable");
  return KnowledgeCandidate.parse(await readKnowledgeBlob(db, String(row.content_sha256)));
}
