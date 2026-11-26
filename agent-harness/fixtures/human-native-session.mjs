import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiPackage } from "../pi-image-packaging.mjs";
import { loadBoundaries } from "./pi-om-real-rpc.mjs";
import { RpcClient } from "./pi-rpc-client.mjs";

export async function runHumanNativePiImport() {
  const root=mkdtempSync(path.join(tmpdir(),"human-native-pi-"));
  const boundary=await loadBoundaries(root);
  const sourceDir=process.env.DEEPSONAR_RPC_BOUNDARY_DIR ?? path.resolve("packages/runtime-sandbox/src");
  const moduleFile=path.join(root,"human-session-import.mjs");
  writeFileSync(moduleFile,stripTypeScriptTypes(readFileSync(path.join(sourceDir,"human-session-import.ts"),"utf8"),{mode:"transform"}));
  const {projectNativeHumanSession}=await import(pathToFileURL(moduleFile).href);
  const {executable,metadata}=resolvePiPackage();
  assert.equal(metadata.version,"1.6.1");
  const calls=[];
  let acceptedWaits=0, acknowledgedReplies=0;
  let acceptWait;
  const waitAccepted=new Promise(resolve=>{acceptWait=resolve;});
  const commandFor=operation=>{
    const code=`import os,urllib.request; token=open(os.environ["DEEPSONAR_CONTROL_TOKEN_FILE"]).read(); r=urllib.request.Request("http://127.0.0.1:${server.address().port}/control/${operation}",data=b"{}",headers={"Authorization":"Bearer "+token}); print(urllib.request.urlopen(r).read().decode())`;
    return `python3 -c '${code}'`;
  };
  const server=createServer(async(req,res)=>{
    if(req.url==='/control/request_human') {
      assert.equal(req.headers.authorization,'Bearer old-control-identity');
      acceptedWaits++;acceptWait();
      // The host has accepted the wait. Do not return a native tool result.
      return;
    }
    if(req.url==='/control/ack_human_message') {
      assert.equal(req.headers.authorization,'Bearer new-control-identity');
      acknowledgedReplies++;res.writeHead(200).end('ACK_NEW_REPLY');return;
    }
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));calls.push(body);
    assert.equal(req.headers.authorization,`Bearer ${calls.length===1?'old':'new'}-native-fixture-key`);
    assert.ok(body.tools.some(tool=>tool.function.name==='bash'));
    res.writeHead(200,{"content-type":"text/event-stream"});
    const base={id:"human-native",object:"chat.completion.chunk",created:1,model:"human-native"};
    const operation=calls.length===1?'request_human':calls.length===2?'ack_human_message':undefined;
    const delta=operation ? {role:"assistant",tool_calls:[{index:0,id:`native-tool-${calls.length}`,type:"function",
      function:{name:"bash",arguments:JSON.stringify({command:commandFor(operation)})}}]} : {role:"assistant",content:"NATIVE_HISTORY_RETAINED"};
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:operation?"tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`);res.end();
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let client;
  try {
    const start=(home,sessionFile)=>{
      mkdirSync(home,{recursive:true,mode:0o700});
      const credentials=path.join(home,`.deepsonar-credentials-${randomUUID()}`);
      mkdirSync(credentials,{mode:0o700});
      const controlFile=path.join(credentials,"control-token");
      writeFileSync(controlFile,sessionFile?"new-control-identity":"old-control-identity",{mode:0o600});
      writeFileSync(path.join(home,"auth.json"),JSON.stringify({fixture:{type:"api_key",key:sessionFile?"new-native-fixture-key":"old-native-fixture-key"}}),{mode:0o600,flag:"wx"});
      writeFileSync(path.join(home,"models.json"),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}`,api:"openai-completions",
        models:[{id:"human-native",name:"human-native",reasoning:false,input:["text"],maxTokens:128,contextWindow:100000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
      return new RpcClient(executable,["--provider","fixture","--model","human-native","--system-prompt",sessionFile?"CURRENT_SYSTEM_BOUNDARY":"OLD_SYSTEM_BOUNDARY",...(sessionFile?["--session",sessionFile]:[])],{
        cwd:"/workspace",detached:true,env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:home,DEEPSONAR_CONTROL_TOKEN_FILE:controlFile},
      },boundary.PiJsonlFramer,line=>boundary.parsePiJsonlRecord(line,8*1024*1024));
    };
    client=start(path.join(root,"old-home"));
    const before=await client.command("get_state");
    const interrupted=client.turn("Preserve ORIGINAL_NATIVE_DECISION.\nAuthorization: Bearer old-control-identity").catch(()=>undefined);
    const deadline=setTimeout(()=>acceptWait(new Error('human tool was not accepted')),20_000);
    const waitResult=await waitAccepted;clearTimeout(deadline);
    assert.equal(waitResult,undefined);assert.equal(acceptedWaits,1);
    process.kill(-client.child.pid,'SIGKILL');await client.stop(true);await interrupted;
    const original=readFileSync(before.data.sessionFile,"utf8");
    const originalRows=original.trim().split("\n").map(line=>JSON.parse(line));
    assert.ok(originalRows.some(row=>row.message?.content?.some?.(block=>block.type==='toolCall')));
    assert.ok(!originalRows.some(row=>row.message?.role==='toolResult'),'stop before tool result is written');
    const projected=projectNativeHumanSession("pi","1.6.1",before.data.sessionId,original);
    assert.equal(projected.status,"supported");
    assert.doesNotMatch(projected.content,/old-control-identity/);
    // Pi migrates agent-root JSONL files before resolving --session. Use the
    // production session directory so startup cannot move the imported file.
    const newHome=path.join(root,"new-home");
    const imported=path.join(newHome,"sessions","--workspace--",`${before.data.sessionId}.jsonl`);mkdirSync(path.dirname(imported),{recursive:true});
    writeFileSync(imported,projected.content);
    client=start(newHome,imported);
    const after=await client.command("get_state");
    console.log(JSON.stringify({human_native_identity:{before:before.data.sessionId,header:JSON.parse(projected.content.split('\n')[0]).id,after:after.data.sessionId,
      expectedFile:imported,observedFile:after.data.sessionFile,records:projected.content.trim().split('\n').map(line=>JSON.parse(line).type),stderr:client.stderr.slice(-512)}}));
    assert.equal(after.data.sessionId,before.data.sessionId);assert.equal(after.data.sessionFile,imported);
    await client.turn("Continue after the human reply using the new execution identity.");
    assert.ok(JSON.stringify(calls.at(-1).messages).includes("ORIGINAL_NATIVE_DECISION"));
    assert.doesNotMatch(JSON.stringify(calls.at(-1)),/old-control-identity|OLD_SYSTEM_BOUNDARY/);
    assert.match(JSON.stringify(calls.at(-1).messages),/CURRENT_SYSTEM_BOUNDARY/);
    assert.equal(acceptedWaits,1);assert.equal(acknowledgedReplies,1);
    assert.doesNotMatch(client.stderr,/tool.*(?:pair|missing)|protocol error/iu);
    return {human_native_pi:"passed",version:metadata.version,processes:2,accepted_waits:acceptedWaits,acknowledged_replies:acknowledgedReplies};
  } finally {
    await client?.stop(true);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});
  }
}
