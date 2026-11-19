import { z } from "zod";
import { nativeHumanSessionCapability, projectNativeHumanSession, type NativeHumanSession } from "@deepsonar/runtime-sandbox";
import { sql } from "../../db.js";
import { readEvidenceManifest, readSessionArtifact } from "../../evidence.js";
import { putCheckpointFile, readCheckpointFile, checkpointHash } from "./human-checkpoint-files.js";
import { humanSnapshotDigest } from "./human-continuation-store.js";
import { redactJobHumanRequestText } from "./job-human-request.js";

const Binding = z.object({
  v:z.literal(1),request_id:z.string().uuid(),job_id:z.string().uuid(),attempt_id:z.string().uuid(),
  snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/u),cli:z.enum(["pi","claude-code","dsh"]),version:z.string().max(32),
  status:z.enum(["supported","unsupported","rejected"]),reason:z.string().max(96),
  session_id:z.string().uuid().optional(),bytes:z.number().int().min(1).max(8*1024*1024).optional(),
  sha256:z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

/** Bind once to the exact exported source Attempt. Files share checkpoint expiry/deletion. */
export async function captureHumanSession(jobId:string,attemptId:string,secrets:readonly string[]) {
  const [source]=await sql`SELECT r.id AS request_id,j.agent_snapshot_json,a.session_id,a.state_json
    FROM human_requests r JOIN jobs j ON j.id=r.job_id JOIN job_attempts a ON a.id=r.attempt_id AND a.job_id=j.id
    WHERE r.job_id=${jobId} AND a.id=${attemptId} AND j.status='waiting_human'
      AND r.checkpoint_status='preparing' AND r.status IN ('open','answered') AND r.manifest_json IS NULL`;
  if (!source || source.state_json?.human_session) return;
  const snapshot=source.agent_snapshot_json;
  const cli=snapshot.agent_cli,version=snapshot.agent_runtime?.adapter_version;
  const capability=nativeHumanSessionCapability(cli,version);
  const binding:Record<string,unknown>={v:1,request_id:String(source.request_id),job_id:jobId,attempt_id:attemptId,
    snapshot_sha256:humanSnapshotDigest(snapshot),cli,version,...capability};
  delete binding.mode;
  if (capability.status === "supported") {
    binding.status="rejected";binding.reason="source_archive_unavailable";
    try {
    const manifest=await readEvidenceManifest(jobId);
    const candidates=manifest?.files.filter(file=>file.kind==='main' && file.path.startsWith(`attempts/${attemptId}/sessions/`)) ?? [];
    if (manifest?.cli===cli && manifest.session_id===source.session_id && candidates.length===1 && !manifest.capture_error) {
      const file=candidates[0]!;
      const archive=await readSessionArtifact(jobId,file.path);
      if (archive && !archive.projection && archive.content.length===file.bytes && checkpointHash(archive.content)===file.sha256) {
        const text=archive.content.toString('utf8');
        // Project each parsed record so redaction cannot corrupt JSON framing.
        try {
          const redacted=text.trim().split('\n').map(line=>{
            let projected=JSON.stringify(redactJobHumanRequestText(JSON.parse(line)));
            for(const secret of [...secrets].sort((a,b)=>b.length-a.length)) if(secret)
              projected=projected.split(JSON.stringify(secret).slice(1,-1)).join('[Excluded secret]');
            return projected;
          }).join('\n');
          const projected=projectNativeHumanSession(cli,version,String(source.session_id),redacted);
          binding.status=projected.status;binding.reason=projected.reason;
          if(projected.status==='supported' && projected.content) {
            Object.assign(binding,await putCheckpointFile(String(source.request_id),Buffer.from(projected.content)),{session_id:String(source.session_id)});
          }
        } catch { binding.reason="invalid_session_json"; }
      } else binding.reason="source_archive_integrity";
    }
    } catch { binding.status="rejected";binding.reason="source_archive_capture_failed"; }
  }
  const parsed=Binding.parse(binding);
  await sql`UPDATE job_attempts SET state_json=jsonb_set(state_json,'{human_session}',${sql.json(parsed)}),updated_at=now()
    WHERE id=${attemptId} AND job_id=${jobId} AND NOT(state_json ? 'human_session')`;
}

export async function loadHumanSession(jobId:string,attemptNo:number,snapshot:unknown):Promise<{
  session?:NativeHumanSession;status:string;reason:string;
}> {
  const [source]=await sql`SELECT a.state_json,r.id AS request_id,r.attempt_id FROM human_requests r
    JOIN job_attempts a ON a.id=r.attempt_id AND a.job_id=r.job_id
    WHERE r.job_id=${jobId} AND r.target_attempt_no=${attemptNo} AND r.resumed_at IS NOT NULL
      AND r.checkpoint_status='ready' AND r.resources_released_at IS NOT NULL AND r.process_exited_at IS NOT NULL
      AND r.checkpoint_expires_at>now() ORDER BY r.created_at DESC,r.id DESC LIMIT 1`;
  if(!source?.state_json?.human_session) return {status:"unsupported",reason:"checkpoint_has_no_native_archive"};
  const binding=Binding.parse(source.state_json.human_session);
  const frozen=snapshot as {agent_cli?:string;agent_runtime?:{adapter_version?:string}};
  if(binding.job_id!==jobId || binding.attempt_id!==source.attempt_id || binding.request_id!==source.request_id
    ||binding.snapshot_sha256!==humanSnapshotDigest(snapshot) || binding.cli!==frozen.agent_cli
    ||binding.version!==frozen.agent_runtime?.adapter_version) throw new Error("HUMAN_NATIVE_SESSION_IDENTITY");
  if(binding.status!=="supported") return binding;
  if(!binding.session_id||!binding.bytes||!binding.sha256||binding.cli==='dsh') throw new Error("HUMAN_NATIVE_SESSION_INCOMPLETE");
  const content=(await readCheckpointFile(binding.request_id,{bytes:binding.bytes,sha256:binding.sha256})).toString('utf8');
  const projected=projectNativeHumanSession(binding.cli,binding.version,binding.session_id,content);
  if(projected.status!=="supported"||!projected.content) throw new Error("HUMAN_NATIVE_SESSION_FORMAT");
  return {status:"supported",reason:binding.reason,session:{cli:binding.cli,version:binding.version,sessionId:binding.session_id,content:projected.content}};
}
