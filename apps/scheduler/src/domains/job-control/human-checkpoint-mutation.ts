import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { shellQuote } from "@deepsonar/runtime-sandbox";

/** Kernel notifications, independent of the file candidate list. Overflow fails closed. */
export const CHECKPOINT_MUTATION_GUARD = `import os,sys,json,ctypes,struct,select
root=sys.argv[1]
libc=ctypes.CDLL(None,use_errno=True)
descriptor=libc.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
if descriptor<0: raise RuntimeError('inotify unavailable')
changed=False
count=0
mask=0x00000002|0x00000004|0x00000008|0x00000040|0x00000080|0x00000100|0x00000200|0x00000400|0x00000800
for directory,dirs,names in os.walk(root,followlinks=False):
 dirs[:]=[name for name in dirs if not name.startswith('.deepsonar') and name not in ['.git','.ssh','.aws','.config','.claude','.pi','.codex','.opencode']]
 count+=1
 if count>4096: raise RuntimeError('too many directories')
 if libc.inotify_add_watch(descriptor,os.fsencode(directory),mask)<0: raise RuntimeError('watch unavailable')
 for dirname in dirs:
  if os.path.islink(os.path.join(directory,dirname)): raise RuntimeError('unsafe directory')
def drain():
 global changed
 while True:
  try: payload=os.read(descriptor,65536)
  except BlockingIOError: break
  if not payload: raise RuntimeError('watch lost')
  changed=True
  # Every event, including IN_Q_OVERFLOW / IN_IGNORED, invalidates this capture.
drain()
with open('/proc/self/stat') as source: fields=source.read().rsplit(')',1)[1].split()
print(json.dumps({'ready':str(os.getpid())+':'+fields[19]}),flush=True)
while True:
 readable,_,_=select.select([descriptor,sys.stdin],[],[],1)
 if descriptor in readable: drain()
 if sys.stdin in readable:
  command=sys.stdin.readline()
  if command!='seal\\n': raise RuntimeError('guard input closed')
  drain()
  print(json.dumps({'sealed':not changed}),flush=True)
  break
os.close(descriptor)
`;

export async function guardCheckpointMutations(host:RuntimeHost) {
  const process=await host.runAsync(`python3 -c ${shellQuote(CHECKPOINT_MUTATION_GUARD)} /workspace`,{cwd:'/workspace',timeoutMs:60_000});
  let readyResolve!:(identity:string)=>void,readyReject!:(error:Error)=>void;
  let sealedResolve!:(sealed:boolean)=>void;
  const ready=new Promise<string>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const sealed=new Promise<boolean>(resolve=>{sealedResolve=resolve;});
  let exitedCleanly=false;
  const collector=(async()=>{
    let buffered='';
    try {
      for await(const chunk of process) {
        if(chunk.type==='exit') {exitedCleanly=chunk.exitCode===0;continue;}
        if(chunk.type!=='stdout') continue;
        buffered+=chunk.chunk;
        if(buffered.length>4096) throw new Error('invalid guard output');
        let newline:number;
        while((newline=buffered.indexOf('\n'))>=0) {
          const value=JSON.parse(buffered.slice(0,newline));buffered=buffered.slice(newline+1);
          if(typeof value.ready==='string'&&/^\d+:\d+$/.test(value.ready)) readyResolve(value.ready);
          if(typeof value.sealed==='boolean') sealedResolve(value.sealed);
        }
      }
    } catch { /* Host failure is a failed consistency proof. */ }
    finally { readyReject(new Error('HUMAN_CHECKPOINT_GUARD_UNAVAILABLE'));sealedResolve(false); }
  })();
  const deadline=async<T>(promise:Promise<T>)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('HUMAN_CHECKPOINT_GUARD_TIMEOUT')),5000);})]);}
    finally {if(timer)clearTimeout(timer);}
  };
  try {
    const identity=await deadline(ready);
    return {identity,assertUnchanged:async()=>{
      await process.write('seal\n');
      if(!await deadline(sealed)) throw new Error('HUMAN_CHECKPOINT_WORKSPACE_CHANGED');
      await deadline(collector);
      if(!exitedCleanly) throw new Error('HUMAN_CHECKPOINT_GUARD_UNAVAILABLE');
    },close:async()=>{await process.kill().catch(()=>{});await deadline(collector).catch(()=>{});}};
  } catch(error) {await process.kill().catch(()=>{});throw error;}
}
