import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { shellQuote, type RuntimeHost } from "@deepsonar/runtime-sandbox";
import { checkpointQuiescenceScript } from "./human-checkpoint-process.js";
import { guardCheckpointMutations } from "./human-checkpoint-mutation.js";

export const HUMAN_CHECKPOINT_MAX_FILES = 256;
export const HUMAN_CHECKPOINT_MAX_BYTES = 64*1024*1024;
export const HUMAN_CHECKPOINT_FILE_BYTES = 8*1024*1024;
export const HUMAN_CHECKPOINT_MANIFEST_VERSION = 2;
const SafeFilePath = z.string().min(1).max(512).refine(value => !value.startsWith("/") && !value.includes("\\") && !/[\x00-\x1f\x7f:]/.test(value)
  && !value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".deepsonar")
    || [".git",".ssh",".aws",".config",".claude",".pi",".codex",".opencode"].includes(part)
    || part === ".env" || part.startsWith(".env.") || /^(?:credentials?|tokens?|secrets?)(?:\.|$)/i.test(part)));
const CheckpointFile = z.object({
  path:SafeFilePath,bytes:z.number().int().min(0).max(HUMAN_CHECKPOINT_FILE_BYTES),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),mode:z.union([z.literal(0o600),z.literal(0o700)]),
}).strict();
const CheckpointFiles = z.array(CheckpointFile).max(HUMAN_CHECKPOINT_MAX_FILES)
  .refine(files=>new Set(files.map(file=>file.path)).size===files.length
    && files.reduce((total,file)=>total+file.bytes,0)<=HUMAN_CHECKPOINT_MAX_BYTES);
export const HumanCheckpointManifest = z.object({
  v: z.literal(HUMAN_CHECKPOINT_MANIFEST_VERSION), job_id:z.string().uuid(), attempt_id:z.string().uuid(), request_id:z.string().uuid(),
  snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/), mode:z.literal("structured"),
  files:CheckpointFiles,
}).strict();
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
  const guard=await guardCheckpointMutations(host);
  try {
  const script=`import os,json,stat,hashlib
${checkpointQuiescenceScript([...processBaseline,guard.identity])}
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
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise RuntimeError('HUMAN_CHECKPOINT_UNSAFE_FILE')
  if info.st_size>${HUMAN_CHECKPOINT_FILE_BYTES}: raise RuntimeError('HUMAN_CHECKPOINT_SIZE_LIMIT')
  with open(full,'rb') as source: digest=hashlib.sha256(source.read(${HUMAN_CHECKPOINT_FILE_BYTES}+1)).hexdigest()
  files.append({'path':relative,'bytes':info.st_size,'sha256':digest,'mode':0o600|(info.st_mode&0o100)})
  total+=info.st_size
  if len(files)>${HUMAN_CHECKPOINT_MAX_FILES} or total>${HUMAN_CHECKPOINT_MAX_BYTES}: raise RuntimeError('HUMAN_CHECKPOINT_SIZE_LIMIT')
print(json.dumps(files))`;
  const scan=await host.run(`python3 - <<'DEEPSONAR_CHECKPOINT'\n${script}\nDEEPSONAR_CHECKPOINT`,{cwd:"/workspace",timeoutMs:30_000});
  if(scan.exitCode!==0) throw new Error("HUMAN_CHECKPOINT_SCAN_FAILED");
  const candidates=CheckpointFiles.parse(JSON.parse(scan.stdout));
  const files:z.infer<typeof CheckpointFile>[]=[];
  for(const file of candidates) {
    const bytes=await host.readWorkspaceFile(`/workspace/${file.path}`,HUMAN_CHECKPOINT_FILE_BYTES);
    if(bytes.length!==file.bytes||checkpointHash(bytes)!==file.sha256) throw new Error("HUMAN_CHECKPOINT_FILE_CHANGED");
    if(secrets.some(secret=>secret.length>0&&bytes.includes(Buffer.from(secret)))) throw new Error("HUMAN_CHECKPOINT_SECRET_DETECTED");
    if(files.reduce((total,entry)=>total+entry.bytes,0)+bytes.length>HUMAN_CHECKPOINT_MAX_BYTES) throw new Error("HUMAN_CHECKPOINT_SIZE_LIMIT");
    files.push({path:file.path,mode:file.mode,...await putCheckpointFile(requestId,bytes)});
  }
  await guard.assertUnchanged();
  return files;
  } finally {await guard.close();}
}

/** New sandbox only, before any Agent starts. Never applies modes to managed inputs or directories. */
export async function restoreCheckpointFiles(host:RuntimeHost,requestId:string,input:HumanCheckpointManifest['files']) {
  const files=CheckpointFiles.parse(input);
  const restored=[];
  for(const file of files) restored.push({file,bytes:await readCheckpointFile(requestId,file)});
  if(files.length===0) return restored;
  const script=`import os,sys,json,stat,hashlib
files=json.loads(sys.argv[1])
finalize=sys.argv[2]=='finalize'
root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for entry in files:
  parent=os.dup(root)
  try:
   parts=entry['path'].split('/')
   for component in parts[:-1]:
    if not finalize:
     try: os.mkdir(component,0o700,dir_fd=parent)
     except FileExistsError: pass
    child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    os.close(parent)
    parent=child
   try: info=os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
   except FileNotFoundError:
    if finalize: raise
    continue
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise RuntimeError('unsafe file')
   if finalize:
    descriptor=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    try:
     current=os.fstat(descriptor)
     if not stat.S_ISREG(current.st_mode) or current.st_nlink!=1 or current.st_size!=entry['bytes']: raise RuntimeError('unsafe file')
     with os.fdopen(os.dup(descriptor),'rb') as source: digest=hashlib.sha256(source.read(${HUMAN_CHECKPOINT_FILE_BYTES}+1)).hexdigest()
     if digest!=entry['sha256']: raise RuntimeError('file changed')
     os.fchmod(descriptor,entry['mode'])
     if stat.S_IMODE(os.fstat(descriptor).st_mode)!=entry['mode']: raise RuntimeError('mode not applied')
    finally: os.close(descriptor)
  finally: os.close(parent)
finally: os.close(root)`;
  // Bound each argv below Linux's per-argument limit even for maximum-length Unicode paths.
  const commands:string[]=[];
  for(let offset=0;offset<files.length;offset+=32) {
    commands.push(`python3 -c ${shellQuote(script)} ${shellQuote(JSON.stringify(files.slice(offset,offset+32)))}`);
  }
  for(const command of commands) {
    const prepare=await host.run(`${command} prepare`,{cwd:'/workspace',timeoutMs:30_000});
    if(prepare.exitCode!==0) throw new Error('HUMAN_CHECKPOINT_RESTORE_FAILED');
  }
  for(const {file,bytes} of restored) await host.uploadFile(bytes,`/workspace/${file.path}`);
  for(const command of commands) {
    const finalize=await host.run(`${command} finalize`,{cwd:'/workspace',timeoutMs:30_000});
    if(finalize.exitCode!==0) throw new Error('HUMAN_CHECKPOINT_RESTORE_FAILED');
  }
  return restored;
}
