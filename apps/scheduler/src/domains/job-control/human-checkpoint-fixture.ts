import type { RuntimeProcess } from "@deepsonar/runtime-sandbox";

/** Controlled RuntimeHost stream; real kernel watch behavior has separate Linux coverage. */
export function checkpointGuardFixture():RuntimeProcess {
  let finish!:()=>void;
  const completion=new Promise<void>(resolve=>{finish=resolve;});
  return {
    stdinClosed:false,write:async()=>{finish();},closeStdin:async()=>{finish();},kill:async()=>{finish();},
    async *[Symbol.asyncIterator]() {
      yield {type:'stdout' as const,chunk:'{"ready":"90001:12345"}\n'};
      await completion;
      yield {type:'stdout' as const,chunk:'{"sealed":true}\n'};
      yield {type:'exit' as const,exitCode:0};
    },
  };
}
