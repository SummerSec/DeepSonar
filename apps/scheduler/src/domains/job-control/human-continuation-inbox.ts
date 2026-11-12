import { createHash } from "node:crypto";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { sql } from "../../db.js";
import { readSharedAssetBlob } from "../shared-assets/index.js";

/** Rebuild cumulative known inputs; never deliver an acknowledged message again. */
export async function readAcknowledgedHumanAttachments(jobId:string,db:typeof sql=sql):Promise<Array<{path:string;bytes:Buffer}>> {
  const files=await db`SELECT m.id AS message_id,a.workspace_path,a.content_sha256,a.bytes,b.blob_uri FROM human_messages m
    JOIN human_message_attachments a ON a.message_id=m.id
    JOIN shared_asset_versions v ON v.id=a.version_id
    JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    WHERE m.target_job_id=${jobId} AND m.delivery_status='acknowledged'
    ORDER BY m.planned_at,m.id,a.workspace_path LIMIT 257`;
  if(files.length>256||files.some(file=>Number(file.bytes)>8*1024*1024)
    ||files.reduce((sum,file)=>sum+Number(file.bytes),0)>64*1024*1024) throw new Error('HUMAN_CHECKPOINT_INBOX_LIMIT');
  const inputs:Array<{path:string;bytes:Buffer}>=[];
  for(const file of files) {
    const prefix=`/workspace/.deepsonar/inbox/${String(file.message_id)}/`,destination=String(file.workspace_path);
    const filename=destination.slice(prefix.length);
    if(!destination.startsWith(prefix)||!filename||filename==='.'||filename==='..'||!/^[A-Za-z0-9._-]+$/.test(filename))
      throw new Error('HUMAN_CHECKPOINT_INBOX_PATH');
    const bytes=await readSharedAssetBlob(String(file.blob_uri));
    if(bytes.length!==Number(file.bytes)||createHash('sha256').update(bytes).digest('hex')!==file.content_sha256)
      throw new Error('HUMAN_CHECKPOINT_INBOX_HASH_MISMATCH');
    inputs.push({path:destination,bytes});
  }
  return inputs;
}

export async function restoreAcknowledgedHumanAttachments(jobId:string,host:RuntimeHost):Promise<string[]> {
  const files=await readAcknowledgedHumanAttachments(jobId);
  for(const file of files) await host.writeHumanInboxFile(file.path,file.bytes);
  return files.map(file=>file.path);
}
