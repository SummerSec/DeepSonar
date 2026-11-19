import assert from "node:assert/strict";
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
  assert.equal(metadata.version,"1.5.2");
  const calls=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));calls.push(body);
    assert.equal(req.headers.authorization,"Bearer new-native-fixture-key");
    res.writeHead(200,{"content-type":"text/event-stream"});
    const base={id:"human-native",object:"chat.completion.chunk",created:1,model:"human-native"};
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",content:"NATIVE_HISTORY_RETAINED"},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`);res.end();
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let client;
  try {
    const start=(home,sessionFile)=>{
      mkdirSync(home,{recursive:true});
      writeFileSync(path.join(home,"models.json"),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}`,api:"openai-completions",apiKey:"new-native-fixture-key",
        models:[{id:"human-native",name:"human-native",reasoning:false,input:["text"],maxTokens:128,contextWindow:100000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
      return new RpcClient(executable,["--provider","fixture","--model","human-native",...(sessionFile?["--session",sessionFile]:[])],{
        cwd:"/workspace",env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:home},
      },boundary.PiJsonlFramer,line=>boundary.parsePiJsonlRecord(line,8*1024*1024));
    };
    client=start(path.join(root,"old-home"));
    const before=await client.command("get_state");
    await client.turn("Preserve ORIGINAL_NATIVE_DECISION.\nAuthorization: Bearer old-control-identity");
    await client.stop(true);
    const original=readFileSync(before.data.sessionFile,"utf8");
    const projected=projectNativeHumanSession("pi","1.5.2",before.data.sessionId,original);
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
    assert.doesNotMatch(JSON.stringify(calls.at(-1)),/old-control-identity/);
    return {human_native_pi:"passed",version:metadata.version,processes:2};
  } finally {
    await client?.stop(true);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});
  }
}
