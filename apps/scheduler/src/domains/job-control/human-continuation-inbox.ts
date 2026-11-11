import { createHash } from "node:crypto";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { sql } from "../../db.js";
import { readSharedAssetBlob } from "../shared-assets/index.js";

/** Rebuild known input files without delivering an acknowledged message again. */
export async function restoreAcknowledgedHumanAttachments(jobId:string,messageId:string,host:RuntimeHost) {
  const files=await sql`SELECT a.workspace_path,a.content_sha256,a.bytes,b.blob_uri FROM human_messages m
    JOIN human_message_attachments a ON a.message_id=m.id
    JOIN shared_asset_versions v ON v.id=a.version_id
    JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    WHERE m.id=${messageId} AND m.target_job_id=${jobId} AND m.delivery_status='acknowledged'
    ORDER BY a.workspace_path LIMIT 21`;
  if(files.length>20) throw new Error('HUMAN_CHECKPOINT_INBOX_LIMIT');
  for(const file of files) {
    if(!String(file.workspace_path).startsWith(`/workspace/.deepsonar/inbox/${messageId}/`)) throw new Error('HUMAN_CHECKPOINT_INBOX_PATH');
    const bytes=await readSharedAssetBlob(String(file.blob_uri));
    if(bytes.length!==Number(file.bytes)||createHash('sha256').update(bytes).digest('hex')!==file.content_sha256)
      throw new Error('HUMAN_CHECKPOINT_INBOX_HASH_MISMATCH');
    await host.writeHumanInboxFile(String(file.workspace_path),bytes);
  }
}
