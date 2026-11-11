import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { checkpointQuiescenceScript } from "./human-checkpoint-process.js";

export const HUMAN_CHECKPOINT_MAX_FILES = 256;
export const HUMAN_CHECKPOINT_MAX_BYTES = 64*1024*1024;
export const HUMAN_CHECKPOINT_FILE_BYTES = 8*1024*1024;
const SafeFilePath = z.string().min(1).max(512).refine(value => !value.startsWith("/") && !value.includes("\\") && !/[\x00-\x1f\x7f:]/.test(value)
  && !value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".deepsonar")
    || [".git",".ssh",".aws",".config",".claude",".pi",".codex",".opencode"].includes(part)
    || part === ".env" || part.startsWith(".env.") || /^(?:credentials?|tokens?|secrets?)(?:\.|$)/i.test(part)));
export const HumanCheckpointManifest = z.object({
  v: z.literal(1), job_id:z.string().uuid(), attempt_id:z.string().uuid(), request_id:z.string().uuid(),
  snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/), mode:z.literal("structured"),
  files:z.array(z.object({path:SafeFilePath,bytes:z.number().int().min(0).max(HUMAN_CHECKPOINT_FILE_BYTES),
    sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(HUMAN_CHECKPOINT_MAX_FILES),
}).strict().refine(value => new Set(value.files.map(file => file.path)).size===value.files.length
  && value.files.reduce((total,file)=>total+file.bytes,0)<=HUMAN_CHECKPOINT_MAX_BYTES);
export type HumanCheckpointManifest = z.infer<typeof HumanCheckpointManifest>;

export function checkpointHash(bytes:Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function blobPath(requestId:string,sha256:string) {
  z.string().uuid().parse(requestId); z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
  return path.join(config.storage.blobDir,"human-checkpoints",requestId,sha256);
}
export async function deleteCheckpointFiles(requestId:string) {
  z.string().uuid().parse(requestId);
  await rm(path.join(config.storage.blobDir,"human-checkpoints",requestId),{recursive:true,force:true});
}
export async function putCheckpointFile(requestId:string,bytes:Buffer) {
  const sha256=checkpointHash(bytes), destination=blobPath(requestId,sha256);
  await mkdir(path.dirname(destination),{recursive:true});
  try { await writeFile(destination,bytes,{flag:"wx",mode:0o600}); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error; }
  const stored=await readFile(destination);
  if(stored.length!==bytes.length||checkpointHash(stored)!==sha256) throw new Error("HUMAN_CHECKPOINT_HASH_MISMATCH");
  return {bytes:bytes.length,sha256};
}
export async function readCheckpointFile(requestId:string,file:{bytes:number;sha256:string}) {
  const source=blobPath(requestId,file.sha256);
  let metadata;
  try { metadata=await lstat(source); } catch { throw new Error("HUMAN_CHECKPOINT_FILE_UNAVAILABLE"); }
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size!==file.bytes||metadata.size>HUMAN_CHECKPOINT_FILE_BYTES)
    throw new Error("HUMAN_CHECKPOINT_HASH_MISMATCH");
  const bytes=await readFile(source);
  if(bytes.length!==file.bytes||checkpointHash(bytes)!==file.sha256) throw new Error("HUMAN_CHECKPOINT_HASH_MISMATCH");
  return bytes;
}
export async function captureCheckpointFiles(host:RuntimeHost,requestId:string,excludedPaths:readonly string[],secrets:readonly string[],processBaseline?:readonly string[]) {
  if(!processBaseline) throw new Error("HUMAN_CHECKPOINT_PROCESS_BASELINE_UNAVAILABLE");
  const script=`import os,json,stat,hashlib
${checkpointQuiescenceScript(processBaseline)}
root='/workspace'
files=[]
total=0
excluded=json.loads(${JSON.stringify(JSON.stringify(excludedPaths.map(value=>value.replace(/^\/workspace\//,""))))})
private_dirs={'.git','.ssh','.aws','.config','.claude','.pi','.codex','.opencode'}
for directory,dirs,names in os.walk(root,followlinks=False):
 dirs[:]=sorted(dirname for dirname in dirs if not dirname.startswith('.deepsonar') and dirname not in private_dirs)
 for dirname in dirs:
  if os.path.islink(os.path.join(directory,dirname)): raise RuntimeError('HUMAN_CHECKPOINT_UNSAFE_FILE')
 for name in sorted(names):
  full=os.path.join(directory,name)
  relative=os.path.relpath(full,root)
  if relative in excluded: continue
  if name=='.env' or name.startswith('.env.') or name.lower().split('.')[0] in ['credential','credentials','token','tokens','secret','secrets']: continue
  info=os.lstat(full)
  if not stat.S_ISREG(info.st_mode): raise RuntimeError('HUMAN_CHECKPOINT_UNSAFE_FILE')
  if info.st_size>${HUMAN_CHECKPOINT_FILE_BYTES}: raise RuntimeError('HUMAN_CHECKPOINT_SIZE_LIMIT')
  with open(full,'rb') as source: digest=hashlib.sha256(source.read(${HUMAN_CHECKPOINT_FILE_BYTES}+1)).hexdigest()
  files.append({'path':relative,'bytes':info.st_size,'sha256':digest})
  total+=info.st_size
  if len(files)>${HUMAN_CHECKPOINT_MAX_FILES} or total>${HUMAN_CHECKPOINT_MAX_BYTES}: raise RuntimeError('HUMAN_CHECKPOINT_SIZE_LIMIT')
print(json.dumps(files))`;
  const scan=await host.run(`python3 - <<'DEEPSONAR_CHECKPOINT'\n${script}\nDEEPSONAR_CHECKPOINT`,{cwd:"/workspace",timeoutMs:30_000});
  if(scan.exitCode!==0) throw new Error("HUMAN_CHECKPOINT_SCAN_FAILED");
  const candidates=z.array(z.object({path:SafeFilePath,bytes:z.number().int().min(0).max(HUMAN_CHECKPOINT_FILE_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict())
    .max(HUMAN_CHECKPOINT_MAX_FILES).parse(JSON.parse(scan.stdout));
  const files:Array<{path:string;bytes:number;sha256:string}>=[];
  for(const file of candidates) {
    const bytes=await host.readWorkspaceFile(`/workspace/${file.path}`,HUMAN_CHECKPOINT_FILE_BYTES);
    if(bytes.length!==file.bytes||checkpointHash(bytes)!==file.sha256) throw new Error("HUMAN_CHECKPOINT_FILE_CHANGED");
    if(secrets.some(secret=>secret.length>0&&bytes.includes(Buffer.from(secret)))) throw new Error("HUMAN_CHECKPOINT_SECRET_DETECTED");
    if(files.reduce((total,entry)=>total+entry.bytes,0)+bytes.length>HUMAN_CHECKPOINT_MAX_BYTES) throw new Error("HUMAN_CHECKPOINT_SIZE_LIMIT");
    files.push({path:file.path,...await putCheckpointFile(requestId,bytes)});
  }
  return files;
}
