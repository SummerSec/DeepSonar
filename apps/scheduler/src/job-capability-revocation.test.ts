import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("terminal paths revoke gateway and platform capability tokens together", async () => {
  const cases: Array<{ file: string; gateway: string; capability: string }> = [
    {
      file: "./core.ts",
      gateway: "revokeJobTokensInTransaction(tx, jobId, `job_${status}`)",
      capability: "revokeJobCapabilityTokens(jobId, `job_${status}`, tx)",
    },
    {
      file: "./reaper.ts",
      gateway: 'revokeJobTokens(jobId, "reaper")',
      capability: 'revokeJobCapabilityTokens(jobId, "reaper")',
    },
    {
      file: "./reconcile.ts",
      gateway: 'revokeJobTokens(jobId, "orphan_reconcile")',
      capability: 'revokeJobCapabilityTokens(jobId, "orphan_reconcile")',
    },
    {
      file: "./domains/job-control/routes.ts",
      gateway: 'revokeJobTokens(id, "cancelled")',
      capability: 'revokeJobCapabilityTokens(id, "cancelled")',
    },
    {
      file: "./domains/job-control/routes.ts",
      gateway: 'revokeJobTokens(jobId, "cancelled")',
      capability: 'revokeJobCapabilityTokens(jobId, "cancelled")',
    },
    {
      file: "./domains/project-task/routes.ts",
      gateway: 'revokeJobTokens(id, "cancelled")',
      capability: 'revokeJobCapabilityTokens(id, "cancelled")',
    },
    {
      file: "./domains/runtime-image/routes.ts",
      gateway: 'revokeJobTokens(job.id as string, "runtime_image_revoked")',
      capability: 'revokeJobCapabilityTokens(job.id as string, "runtime_image_revoked")',
    },
    {
      file: "./dispatcher.ts",
      gateway: 'revokeJobTokens(jobId, "dispatcher_cleanup")',
      capability: "revokeJobCapabilityTokens(jobId)",
    },
  ];

  for (const item of cases) {
    const body = await source(item.file);
    assert.ok(body.includes(item.gateway), `${item.file} must keep ${item.gateway}`);
    assert.ok(body.includes(item.capability), `${item.file} must pair ${item.capability}`);
  }
});

test("priority-drain cancellation revokes platform capability tokens", async () => {
  const body = await source("./core.ts");
  assert.ok(body.includes("UPDATE jobs j SET status = 'cancelled'"));
  assert.ok(body.includes('revokeJobCapabilityTokens(row.id as string, "drain-priority")'));
});

test("dispatcher finally revokes gateway and platform capability tokens together", async () => {
  const body = await source("./dispatcher.ts");
  const finallyBlock = body.match(/\} finally \{[\s\S]*?\n  \}\n\}/);
  assert.ok(finallyBlock, "dispatcher attempt finally block must exist");
  assert.ok(
    finallyBlock[0].includes('revokeJobTokens(jobId, "dispatcher_cleanup")'),
    "dispatcher finally must revoke model gateway tokens after executor failures",
  );
  assert.ok(
    finallyBlock[0].includes("revokeJobCapabilityTokens(jobId)"),
    "dispatcher finally must keep platform capability token revocation",
  );
});

// Execute the actual terminal owner/helper bodies without importing eager DB
// bootstrap. Source AST selection is exact; no reimplemented revoke policy.
async function terminalOwner(ports: Record<string, unknown>) {
  const core=await source("./core.ts");
  const files=[[core,["sameTerminalCanvasNodes","finalizeJob"]],
    [await source("./gateway-token-revocation.ts"),["revokeJobTokensInTransaction"]],
    [await source("./domains/platform-api/tokens.ts"),["revokeJobCapabilityTokens"]]] as const;
  const declarations: string[]=[];
  for(const [body,names] of files) {
    const tree=ts.createSourceFile("terminal-owner.ts",body,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    for(const name of names) {
      const declarationsForName=tree.statements.filter((node)=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
      assert.equal(declarationsForName.length,1,`actual ${name} owner must exist exactly once`);
      declarations.push(declarationsForName[0]!.getText(tree).replace(/^export\s+/u,""));
    }
  }
  const compiled=ts.transpileModule(declarations.join("\n")+"\n;({finalizeJob})",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
  return runInNewContext(compiled.outputText,ports) as {finalizeJob:(tx:unknown,id:string,status:"succeeded"|"failed")=>Promise<boolean>};
}
function terminalTransaction(failTable?:"job_tokens"|"job_capability_tokens") {
  let running=true,gatewayActive=true,capabilityActive=true;
  const writes: Array<{table:string;reason:unknown}>=[];let audits=0;
  const sourceRegistrations: Array<{jobId:string;status:string}>=[];
  const failure=new Error("offline revocation write failed");
  const tx=Object.assign(async(parts:TemplateStringsArray,...values:unknown[])=>{
    const query=parts.join("?").replace(/\s+/gu," ").trim();
    if(query.startsWith("SELECT canvas_id FROM jobs")) return [{canvas_id:null}];
    if(query.startsWith("SELECT id, canvas_id FROM canvas_nodes")) return [];
    if(query.startsWith("SELECT id, canvas_id FROM jobs")) return [{id:"job-fixture",canvas_id:null}];
    if(query.startsWith("SELECT id FROM jobs")) return [{id:"job-fixture"}];
    if(query.startsWith("UPDATE jobs SET")) {if(!running)return [];running=false;return [{id:"job-fixture",canvas_id:null}];}
    if(query.startsWith("UPDATE canvas_nodes SET")) return [];
    if(query.startsWith("UPDATE job_tokens SET")) {
      assert.match(query,/status = 'active'/u);assert.equal(values[1],"job-fixture");
      if(failTable==="job_tokens")throw failure;if(!gatewayActive)return [];gatewayActive=false;
      writes.push({table:"job_tokens",reason:values[0]});return [{id:"gateway-fixture",project_id:"project-fixture"}];
    }
    if(query.startsWith("UPDATE job_capability_tokens")) {
      assert.match(query,/revoked_at IS NULL/u);assert.equal(values[1],"job-fixture");
      if(failTable==="job_capability_tokens")throw failure;if(!capabilityActive)return [];capabilityActive=false;
      writes.push({table:"job_capability_tokens",reason:values[0]});return [{id:"capability-fixture"}];
    }
    if(query.startsWith("INSERT INTO audit_logs")) {
      const body=values[2] as Record<string,unknown>;assert.equal(body.job_id,"job-fixture");
      assert.equal(body.reason,writes[0]!.reason);audits++;return [];
    }
    if(query.startsWith("SELECT * FROM jobs")) return [{id:"job-fixture"}];
    throw new Error(`unexpected terminal query: ${query}`);
  },{json:(value:unknown)=>value});
  return {tx,writes,sourceRegistrations,failure,audits:()=>audits};
}
async function ownerFor(fixture:ReturnType<typeof terminalTransaction>) {
  return terminalOwner({console:{warn:()=>{}},
    lockCanvasForConvergence:async(tx:unknown)=>{assert.equal(tx,fixture.tx);return true;},
    settleAttemptTerminal:async(tx:unknown)=>{assert.equal(tx,fixture.tx);},
    advancePlanTaskAfterTerminal:async(tx:unknown)=>{assert.equal(tx,fixture.tx);},
    registerKnowledgeSourceAfterTerminal:async(tx:unknown,jobId:string,status:string)=>{
      assert.equal(tx,fixture.tx,"source registration must use the caller transaction");
      assert.equal(jobId,"job-fixture");
      assert.deepEqual(fixture.writes,[{table:"job_tokens",reason:`job_${status}`},
        {table:"job_capability_tokens",reason:`job_${status}`}],"both token stores must be revoked before source registration");
      fixture.sourceRegistrations.push({jobId,status});
    },
    planExecutionPorts:{},inc:()=>{},onKnowledgeJobTerminal:async()=>true,
  });
}

for(const status of ["succeeded","failed"] as const) test(`finalizeJob ${status} revokes both token stores in caller transaction, once`,async()=>{
  const f=terminalTransaction(),owner=await ownerFor(f);
  assert.equal(await owner.finalizeJob(f.tx,"job-fixture",status),true);
  assert.deepEqual(f.writes,[{table:"job_tokens",reason:`job_${status}`},{table:"job_capability_tokens",reason:`job_${status}`}]);
  assert.equal(f.audits(),1);
  assert.deepEqual(f.sourceRegistrations,[{jobId:"job-fixture",status}]);
  assert.equal(await owner.finalizeJob(f.tx,"job-fixture",status),false);
  assert.equal(f.writes.length,2);assert.equal(f.audits(),1);
  assert.equal(f.sourceRegistrations.length,1,"duplicate terminal must not register again");
});
for(const table of ["job_tokens","job_capability_tokens"] as const) test(`finalizeJob propagates ${table} revocation failure for caller rollback`,async()=>{
  const f=terminalTransaction(table),owner=await ownerFor(f);
  await assert.rejects(owner.finalizeJob(f.tx,"job-fixture","failed"),error=>error===f.failure);
  assert.equal(f.sourceRegistrations.length,0,"revocation failure must propagate before source registration");
});
