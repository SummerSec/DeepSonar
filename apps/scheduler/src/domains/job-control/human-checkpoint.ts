import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { sql } from "../../db.js";
import { captureCheckpointFiles, HumanCheckpointManifest, readCheckpointFile } from "./human-checkpoint-files.js";
import { humanSnapshotDigest } from "./human-continuation-store.js";
import { projectJobHumanRequestPayload } from "./job-human-request.js";
import type { HumanPayload } from "@deepsonar/shared-types";
import { readCheckpointProcessBaseline } from "./human-checkpoint-process.js";
import { collectSecretValues } from "../../credential-secret-projection.js";

export function checkpointManagedSecrets(env:Record<string,unknown>,files:Record<string,unknown>,direct:readonly(string|null|undefined)[]) {
  return [...new Set([...direct.filter((value):value is string=>typeof value==='string'&&value.length>0),
    ...collectSecretValues(env),...Object.values(files).flatMap(config=>collectSecretValues({config}))])];
}

export async function prepareHumanCheckpointContext(input:{jobId:string;attemptNo:number;snapshot:unknown;host:RuntimeHost}) {
  const continuationInput=await restoreHumanCheckpoint(input);
  const processBaseline=await readCheckpointProcessBaseline(input.host).catch(()=>undefined);
  return {continuationInput,processBaseline};
}

export async function persistHumanWaitCheckpoint(jobId:string,human:{eventId:string;payload:HumanPayload},
  input:{attemptId:string;host:()=>Promise<RuntimeHost>;workspaceFiles:Record<string,unknown>;env:Record<string,unknown>;
    processBaseline?:readonly string[];managedSecrets:readonly(string|null|undefined)[]},
  persist:(jobId:string,event:{v:1;event_id:string;type:"human";payload:HumanPayload})=>Promise<unknown>) {
  await persist(jobId,{v:1,event_id:human.eventId,type:"human",payload:human.payload});
  await sealHumanCheckpoint({jobId,attemptId:input.attemptId,host:await input.host(),processBaseline:input.processBaseline,
    excludedPaths:Object.keys(input.workspaceFiles),secrets:checkpointManagedSecrets(input.env,input.workspaceFiles,input.managedSecrets)});
}

export async function sealHumanCheckpoint(input:{jobId:string;attemptId:string;host:RuntimeHost;
  excludedPaths:readonly string[];secrets:readonly string[];processBaseline?:readonly string[]}) {
  const [request]=await sql`SELECT r.*,j.agent_snapshot_json FROM human_requests r JOIN jobs j ON j.id=r.job_id
    WHERE r.job_id=${input.jobId} AND r.attempt_id=${input.attemptId} AND j.status='waiting_human'
      AND r.status IN ('open','answered') AND r.checkpoint_status='preparing' AND r.manifest_json IS NULL`;
  if(!request) return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const files=await Promise.race([
      captureCheckpointFiles(input.host,String(request.id),input.excludedPaths,input.secrets,input.processBaseline),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("HUMAN_CHECKPOINT_TIMEOUT")),60_000);}),
    ]);
    const manifest=HumanCheckpointManifest.parse({v:1,job_id:input.jobId,attempt_id:input.attemptId,
      request_id:String(request.id),snapshot_sha256:humanSnapshotDigest(request.agent_snapshot_json),mode:"structured",files});
    await sql`UPDATE human_requests SET manifest_json=${sql.json(manifest)},
      checkpoint_status=CASE WHEN resources_released_at IS NOT NULL THEN 'ready' ELSE 'preparing' END
      WHERE id=${request.id} AND checkpoint_status='preparing' AND manifest_json IS NULL`;
  } catch(error) {
    const message=error instanceof Error?error.message:"";
    const code=/^HUMAN_CHECKPOINT_[A-Z_]+$/.test(message)?message:"HUMAN_CHECKPOINT_CAPTURE_FAILED";
    await sql`UPDATE human_requests SET checkpoint_status='blocked',checkpoint_error_code=${code}
      WHERE id=${request.id} AND checkpoint_status='preparing'`;
  } finally { if(timer) clearTimeout(timer); }
}

export async function loadHumanCheckpoint(db:typeof sql,jobId:string,attemptNo:number,snapshot:unknown) {
  const [request]=await db`SELECT * FROM human_requests WHERE job_id=${jobId}
    AND resumed_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`;
  if(!request) return null;
  if(new Date(request.checkpoint_expires_at).getTime()<=Date.now()) throw new Error("HUMAN_CHECKPOINT_EXPIRED");
  if(request.target_attempt_no!==attemptNo) throw new Error("HUMAN_CONTINUATION_OWNER_CHANGED");
  if(request.checkpoint_status!=="ready"||!request.resources_released_at||!request.process_exited_at)
    throw new Error("HUMAN_CHECKPOINT_NOT_READY");
  const manifest=HumanCheckpointManifest.parse(request.manifest_json);
  if(manifest.job_id!==jobId||manifest.attempt_id!==request.attempt_id||manifest.request_id!==request.id
    ||manifest.snapshot_sha256!==humanSnapshotDigest(snapshot)) throw new Error("HUMAN_CHECKPOINT_IDENTITY_CHANGED");
  const [message]=await db`SELECT id,body,delivery_status FROM human_messages WHERE id=${request.reply_message_id}
    AND request_id=${request.id} AND target_job_id=${jobId}`;
  if(!message) throw new Error("HUMAN_CONTINUATION_REPLY_MISSING");
  if(!['planned','acknowledged'].includes(String(message.delivery_status))) throw new Error("HUMAN_CONTINUATION_DELIVERY_UNRESOLVED");
  return {request,manifest,message};
}

/** Recheck the exact queued successor at both pre-provision and pre-agent boundaries. */
export async function assertHumanContinuationOwner(db:typeof sql,jobId:string,attemptId:string) {
  const [owner]=await db`SELECT a.attempt_no,j.agent_snapshot_json,j.status,a.status AS attempt_status,a.cancel_requested,
    c.target_json FROM jobs j JOIN job_attempts a ON a.job_id=j.id LEFT JOIN canvases c ON c.id=j.canvas_id
    WHERE j.id=${jobId} AND a.id=${attemptId}`;
  if(!owner) throw new Error("HUMAN_CONTINUATION_OWNER_CHANGED");
  const saved=await loadHumanCheckpoint(db,jobId,Number(owner.attempt_no),owner.agent_snapshot_json);
  if(!saved) return;
  if(!['claimed','provisioning','running'].includes(owner.status)||owner.attempt_status!=='active'||owner.cancel_requested)
    throw new Error("HUMAN_CONTINUATION_OWNER_CHANGED");
  const [generation]=await db`SELECT event_id FROM events WHERE job_id=${jobId} AND type='control_receipt'
    AND payload_json->>'authority'='scheduler' AND payload_json->>'subtype'='human_continuation'
    AND payload_json->>'request_id'=${String(saved.request.id)}
    AND payload_json->>'target_attempt_no'=${String(owner.attempt_no)} LIMIT 1`;
  if(!generation) throw new Error("HUMAN_CONTINUATION_GENERATION_MISSING");
  for(const file of saved.manifest.files) await readCheckpointFile(String(saved.request.id),file);
}

export async function restoreHumanCheckpoint(input:{jobId:string;attemptNo:number;snapshot:unknown;host:RuntimeHost}) {
  const saved=await loadHumanCheckpoint(sql,input.jobId,input.attemptNo,input.snapshot);
  if(!saved) return "";
  const files=[];
  for(const file of saved.manifest.files) files.push({file,bytes:await readCheckpointFile(String(saved.request.id),file)});
  // The successor is a fresh sandbox; no old process can mutate these paths.
  for(const {file,bytes} of files) await input.host.uploadFile(bytes,`/workspace/${file.path}`);
  const acknowledgedHistory=saved.message.delivery_status==='acknowledged'
    ? `Previously acknowledged reply history (already processed; do not execute it twice): ${String(saved.message.body)}\n` : '';
  return `[Scheduler continuation: structured new session]\nContinue the same authorized task from the restored workspace and existing Canvas facts. Do not replay accepted effects. Recheck changing external prerequisites.\nPrevious request: ${JSON.stringify(projectJobHumanRequestPayload(saved.request.payload_json))}\nSaved reply reference: ${String(saved.message.id)}; delivery status: ${String(saved.message.delivery_status)}. Pending reply contents are delivered only through the governed inbox. Never replay unknown delivery.\n${acknowledgedHistory}Process delivered input and ack_human_message before completing; reading a reference alone is not an ACK.\nRestored file count: ${files.length}; sample: ${JSON.stringify(files.slice(0,24).map(entry=>entry.file.path))}\n`;
}
