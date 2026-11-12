import { z } from "zod";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { shellQuote } from "@deepsonar/runtime-sandbox";

// Only PID/start-time identities cross this boundary, never argv or environment.
const ProcessBaseline = z.array(z.string().regex(/^\d+:\d+$/)).max(4096);
export async function readCheckpointProcessBaseline(host: RuntimeHost): Promise<string[]> {
  const result = await host.run(`python3 -c ${shellQuote(`import os,json
identities=[]
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  with open('/proc/'+name+'/stat') as source: fields=source.read().rsplit(')',1)[1].split()
  identities.append(name+':'+fields[19])
 except FileNotFoundError: pass
print(json.dumps(identities))` )}`, { timeoutMs: 5000 });
  if (result.exitCode !== 0) throw new Error("HUMAN_CHECKPOINT_PROCESS_BASELINE_UNAVAILABLE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // 宿主 stdout 不可解析时与采集失败同一稳定码；不回显原始字节（可能含未脱敏进程信息），
    // 调用方 human-checkpoint.ts 已按失败降级（processBaseline=undefined）。
    throw new Error("HUMAN_CHECKPOINT_PROCESS_BASELINE_UNAVAILABLE");
  }
  return ProcessBaseline.parse(parsed);
}

/** Linux sandbox PID namespace only. New business processes stay stopped until destroy. */
export function checkpointQuiescenceScript(baseline: readonly string[]) {
  const parsed = ProcessBaseline.parse(baseline);
  return `import signal,time
baseline=set(json.loads(${JSON.stringify(JSON.stringify(parsed))}))
def process_info(pid):
 try:
  with open('/proc/'+str(pid)+'/stat') as source: fields=source.read().rsplit(')',1)[1].split()
  return (str(pid)+':'+fields[19],fields[0],int(fields[1]))
 except FileNotFoundError: return None
ancestors=set()
ancestor=os.getpid()
while ancestor>0:
 ancestors.add(ancestor)
 info=process_info(ancestor)
 if info is None: raise RuntimeError('HUMAN_CHECKPOINT_PROCESS_CHANGED')
 ancestor=info[2]
previous_candidates=None
deadline=time.monotonic()+10
for pass_number in range(32):
 candidates=set()
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name) in ancestors: continue
  info=process_info(int(name))
  if info is None or info[0] in baseline or info[1] in ['Z','X']: continue
  candidates.add(info[0])
  if info[1] in ['T','t']: continue
  try: os.kill(int(name),signal.SIGSTOP)
  except ProcessLookupError: continue
  for check_number in range(100):
   current=process_info(int(name))
   if current is None or current[0]!=info[0] or current[1] in ['T','t','Z','X']: break
   time.sleep(0.01)
  else: raise RuntimeError('HUMAN_CHECKPOINT_PROCESS_NOT_QUIESCENT')
 verified=set()
 stable=True
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name) in ancestors: continue
  info=process_info(int(name))
  if info is None or info[0] in baseline or info[1] in ['Z','X']: continue
  verified.add(info[0])
  if info[1] not in ['T','t']: stable=False
 if stable and candidates==verified and verified==previous_candidates: break
 if time.monotonic()>deadline: raise RuntimeError('HUMAN_CHECKPOINT_PROCESS_NOT_QUIESCENT')
 previous_candidates=verified if stable else None
else: raise RuntimeError('HUMAN_CHECKPOINT_PROCESS_NOT_QUIESCENT')
`;
}
