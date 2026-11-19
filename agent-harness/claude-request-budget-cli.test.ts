/** Real pinned Claude CLI, synthetic provider only; not a Scheduler/launch acceptance. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const run = promisify(execFile);
const token = "synthetic-claude-budget-token";
const sentinel = "CLAUDE_BUDGET_SYNTHETIC_BASH_COMPLETED";
const refusal = "MODEL_REQUEST_POLICY_PREGENERATION_REQUIRED";
const optionalThinkingBeta = "thinking-token-count-2026-05-13";
const keptReminderBeta = "mid-conversation-system-clear-at-2026-08-21";
// Locked CLI's native total_tokens reminder: 15,000,000 minus the first
// synthetic response's 100 input + 32 output tokens. This is not Gateway allowance.
const expectedModelToolText = `${sentinel}\n\n<system-reminder>\n<total_tokens>14999868 tokens left</total_tokens>\n</system-reminder>`;

test("Claude pinned native import retains filtered history in a fresh home", {timeout:120_000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"claude-human-native-"));
  const modulePath="/acceptance/human-session-import.mjs";
  const {projectNativeHumanSession}=await import(modulePath);
  const calls:any[]=[];
  let acceptedWaits=0,acknowledgedReplies=0;
  let acceptWait:()=>void;
  const waitAccepted=new Promise<void>(resolve=>{acceptWait=resolve;});
  const commandFor=(operation:string)=>{
    const code=`import urllib.request; r=urllib.request.Request("${url}/control/${operation}",data=b"{}",headers={"Authorization":"Bearer ${operation==='request_human'?'old-control-identity':'new-control-identity'}"}); print(urllib.request.urlopen(r).read().decode())`;
    return `python3 -c '${code}'`;
  };
  const server=http.createServer((req,res)=>{void(async()=>{
    if(req.url==='/control/request_human') {
      assert.equal(req.headers.authorization,'Bearer old-control-identity');
      acceptedWaits++;acceptWait!();return; // Accepted, but no tool result is returned.
    }
    if(req.url==='/control/ack_human_message') {
      assert.equal(req.headers.authorization,'Bearer new-control-identity');
      acknowledgedReplies++;res.writeHead(200).end('ACK_NEW_REPLY');return;
    }
    if(req.url?.includes("count_tokens")) {res.writeHead(200,{"content-type":"application/json"}).end('{"input_tokens":10}');return;}
    const body=JSON.parse((await bytes(req)).toString("utf8"));calls.push(body);
    assert.equal(req.headers["x-api-key"],`${calls.length===1?'old':'new'}-human-fixture-key`);
    res.writeHead(200,{"content-type":"text/event-stream"});
    const operation=calls.length===1?'request_human':calls.length===2?'ack_human_message':undefined;
    const events=[
      {type:"message_start",message:{id:`human-${calls.length}`,type:"message",role:"assistant",model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},
      {type:"content_block_start",index:0,content_block:operation?{type:"tool_use",id:`human-tool-${calls.length}`,name:"Bash",input:{}}:{type:"text",text:""}},
      {type:"content_block_delta",index:0,delta:operation?{type:"input_json_delta",partial_json:JSON.stringify({command:commandFor(operation),description:operation})}:{type:"text_delta",text:"HUMAN_NATIVE_CLAUDE_OK"}},
      {type:"content_block_stop",index:0},
      {type:"message_delta",delta:{stop_reason:operation?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:10}},
      {type:"message_stop"},
    ];
    for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  })().catch(error=>{console.error("native-fixture-request",req.url,String(error));res.writeHead(500).end();});});
  const url=await listen(server);
  const readArchive=async(home:string,sessionId:string)=>{
    const projects=path.join(home,".claude/projects");
    let directories:string[];
    try {directories=await readdir(projects);} catch {return undefined;}
    const archives=await Promise.all(directories.map(async directory=>{
      try {return await readFile(path.join(projects,directory,`${sessionId}.jsonl`),"utf8");} catch {return undefined;}
    }));
    return archives.find(Boolean);
  };
  const launch=async(home:string,resume?:string)=>{
    await mkdir(home,{recursive:true});
    const args=["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--model","claude-sonnet-4-5","--tools","Bash","--append-system-prompt",resume?"CURRENT_SYSTEM_BOUNDARY":"OLD_SYSTEM_BOUNDARY",...(resume?["--resume",resume]:[])];
    const child=spawn("claude",args,{cwd:root,detached:true,env:{...process.env,HOME:home,CLAUDE_CONFIG_DIR:path.join(home,".claude"),
      ANTHROPIC_API_KEY:resume?"new-human-fixture-key":"old-human-fixture-key",ANTHROPIC_BASE_URL:url,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",DISABLE_ERROR_REPORTING:"1",MAX_THINKING_TOKENS:"0"},stdio:["pipe","pipe","pipe"]});
    let output="",pending="",session="";let failed=false;
    child.stdout!.on("data",chunk=>{output+=chunk;pending+=chunk;const lines=pending.split("\n");pending=lines.pop()!;
      for(const line of lines){try{const event=JSON.parse(line);if(event.session_id)session=event.session_id;if(event.type==="result"){failed=event.is_error===true;child.stdin!.end();}}catch{}}
    });
    child.stderr!.on("data",chunk=>{output+=chunk;});
    const stop=()=>{if(child.exitCode===null && child.signalCode===null)process.kill(-child.pid!,"SIGKILL");};
    const timer=setTimeout(stop,50_000);
    const done=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    child.stdin!.write(JSON.stringify({type:"user",message:{role:"user",content:resume?"Continue with the new human decision":"Remember ORIGINAL_CLAUDE_DECISION.\nAuthorization: Bearer old-control-identity"}})+"\n");
    try {
      if(!resume) {
        await Promise.race([waitAccepted,done.then(()=>{throw new Error('CLI exited before accepting human wait');})]);
        assert.equal(acceptedWaits,1);
        // Storage is asynchronous. Keep the accepted tool blocked while its
        // proposal reaches the transcript, then stop before any tool result.
        const deadline=Date.now()+10_000;
        let archivedTool=false;
        while(Date.now()<deadline && !archivedTool) {
          const archive=await readArchive(home,session);
          try {archivedTool=archive?.trim().split("\n").some(line=>JSON.parse(line).message?.content?.some?.((block:any)=>block.type==='tool_use'))===true;} catch {}
          if(!archivedTool)await delay(25);
        }
        assert.ok(archivedTool,'accepted tool proposal must be durably archived before stopping');
        stop();await done;
      } else {assert.equal(await done,0,output.slice(-1000));assert.equal(failed,false);}
      assert.ok(session);return session;
    }finally{clearTimeout(timer);stop();}

  };
  try {
    const home=path.join(root,"old-home"),sessionId=await launch(home);
    const original=await readArchive(home,sessionId);assert.ok(original);
    const originalRows=original.trim().split("\n").map(line=>JSON.parse(line));
    assert.ok(originalRows.some(row=>row.message?.content?.some?.((block:any)=>block.type==='tool_use')));
    assert.ok(!originalRows.some(row=>row.message?.content?.some?.((block:any)=>block.type==='tool_result')),'stop before tool result is written');
    const result=projectNativeHumanSession("claude-code","2.1.312",sessionId,original);
    assert.equal(result.status,"supported",JSON.stringify({status:result.status,reason:result.reason,records:originalRows.map(row=>({type:row.type,operation:row.operation,queuedContentType:row.type==='queue-operation'?typeof row.content:undefined,attachmentType:row.attachment?.type,attachmentKeys:row.attachment?Object.keys(row.attachment):undefined}))}));assert.doesNotMatch(result.content,/old-control-identity/);
    const newHome=path.join(root,"new-home"),projectName=root.replace(/[^a-zA-Z0-9]/gu,"-");
    const destination=path.join(newHome,".claude/projects",projectName);await mkdir(destination,{recursive:true});
    await writeFile(path.join(destination,`${sessionId}.jsonl`),result.content);
    assert.equal(await launch(newHome,sessionId),sessionId);
    assert.match(JSON.stringify(calls.at(-1).messages),/ORIGINAL_CLAUDE_DECISION/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1)),/old-control-identity|OLD_SYSTEM_BOUNDARY/);
    assert.match(JSON.stringify(calls.at(-1).system),/CURRENT_SYSTEM_BOUNDARY/);
    assert.equal(acceptedWaits,1);assert.equal(acknowledgedReplies,1);
  }finally{await close(server);await rm(root,{recursive:true,force:true});}
});
async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: http.Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function bytes(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    assert.ok(size <= 2 * 1024 * 1024, "bounded synthetic CLI request");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("Claude 2.1.312 native launch cap preserves bytes and refuses a later over-budget tool turn", { timeout: 180_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-native-budget-"));
  const credentials = path.join(dir, '.deepsonar-credentials-' + randomUUID());
  await mkdir(credentials, { mode: 0o700 });
  const tokenFile = path.join(credentials, 'gateway-token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const privateAuth = { environment: { DEEPSONAR_GATEWAY_TOKEN_FILE: tokenFile } };
  let stage = "image-version";
  let output = "";
  let resultReceived = false;
  let resultError = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let cli: ChildProcess | undefined;
  let policy: any;
  let remaining = 4096;
  let allowanceQueries = 0;
  let auxiliaryCalls = 0;
  const errors: string[] = [];
  const captured: Buffer[] = [];
  const requestEvidence: Record<string, unknown>[] = [];
  let compatibilityBranch = "unconfirmed";
  const delivered: Buffer[] = [];
  const policyStatuses: number[] = [];
  const policyErrors: string[] = [];
  const nativeToolResults: Array<Record<string, unknown>> = [];
  const progressEvidence = () => {
    const results = captured.flatMap(raw => {
      try {
        const body = JSON.parse(raw.toString("utf8"));
        return (Array.isArray(body.messages) ? body.messages : [])
          .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
          .filter((block: any) => block.type === "tool_result" && block.tool_use_id === "synthetic-bash-tool");
      } catch { return []; } // Diagnostics must not obscure the original failure.
    });
    const matchesSentinel = (block: any) => {
      const value = typeof block.content === "string" ? block.content : Array.isArray(block.content)
        ? block.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
      return value.trim() === sentinel;
    };
    return {
      result_seen: resultReceived, result_is_error: resultError, compatibility_branch: compatibilityBranch,
      stdin_ended: cli?.stdin?.writableEnded === true,
      refusal_code_visible: output.includes(refusal),
      refusal_hint_visible: output.includes("Configure supported CLI options before generating a new request")
        && output.includes("the formed request was not rewritten or sent"),
      native_tool_results: nativeToolResults.map(result => ({
        stdout_is_string: typeof result.stdout === "string", stderr_is_string: typeof result.stderr === "string",
        stdout_equals_sentinel: typeof result.stdout === "string" && result.stdout.trim() === sentinel,
        stdout_sha256: typeof result.stdout === "string" ? createHash("sha256").update(result.stdout).digest("hex") : null,
        stdout_bytes: typeof result.stdout === "string" ? Buffer.byteLength(result.stdout) : null,
        stderr_empty: result.stderr === "", stderr_bytes: typeof result.stderr === "string" ? Buffer.byteLength(result.stderr) : null,
        stderr_sha256: typeof result.stderr === "string" ? createHash("sha256").update(result.stderr).digest("hex") : null,
        cwd_reset_note: typeof result.stderr === "string" && result.stderr.includes("Shell cwd was reset to"),
        interrupted: result.interrupted === true,
        background_task: typeof result.backgroundTaskId === "string", backgrounded_by_user: result.backgroundedByUser === true,
        timed_out: typeof result.timedOutAfterMs === "number", background_cwd_hint: typeof result.backgroundCwdHint === "string",
        raw_output_file: typeof result.rawOutputPath === "string", persisted_output: typeof result.persistedOutputPath === "string",
        persisted_output_size: typeof result.persistedOutputSize === "number" ? result.persistedOutputSize : null,
        stale_read_hint: typeof result.staleReadFileStateHint === "string", rate_limit_hint: typeof result.ghRateLimitHint === "string",
      })),
      tool_result_present: results.length > 0,
      tool_result_success: results.some((block: any) => block.is_error !== true),
      sentinel_matches: results.some(matchesSentinel),
      tool_succeeded: results.some((block: any) => block.is_error !== true && matchesSentinel(block)),
    };
  };
  const remote = http.createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (req.method === "GET" && req.url === "/gateway/_allowance") {
        allowanceQueries++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ policy_required: true, remaining_tokens: remaining }));
        return;
      }
      const route = req.url?.split("?")[0];
      assert.equal(req.method, "POST");
      const raw = await bytes(req);
      const body = JSON.parse(raw.toString("utf8"));
      assert.equal(body.model, "claude-sonnet-4-5");
      // Explicitly support the SDK's read-only token-count helper, if used.
      // No arbitrary startup traffic receives a successful response.
      if (route === "/gateway/v1/messages/count_tokens") {
        auxiliaryCalls++;
        assert.ok(Array.isArray(body.messages));
        res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}');
        return;
      }
      assert.equal(route, "/gateway/v1/messages");
      delivered.push(raw);
      assert.equal(delivered.length, 1, "over-budget follow-up must never reach the provider");
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.stream, true);
      assert.ok(body.tools.some((tool: any) => tool.name === "Bash"));
      remaining = 2048;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events = [
        { type: "message_start", message: { id: "synthetic-message", type: "message", role: "assistant", model: body.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-bash-tool", name: "Bash", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `printf '%s' '${sentinel}'`, description: "Print synthetic budget sentinel" }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 32 } },
        { type: "message_stop" },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    })().catch(() => { errors.push("synthetic-provider-contract"); res.writeHead(500).end(); });
  });
  const capture = http.createServer((req, res) => {
    void (async () => {
      const route = req.url?.split("?")[0];
      assert.equal(req.method, "POST");
      assert.ok(route === "/gateway/v1/messages" || route === "/gateway/v1/messages/count_tokens", "unexpected CLI auxiliary route");
      const raw = await bytes(req);
      if (route === "/gateway/v1/messages") {
        captured.push(raw);
        const body = JSON.parse(raw.toString("utf8"));
        const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
        const results = (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
          .filter((block: any) => block.type === "tool_result" && block.tool_use_id === "synthetic-bash-tool");
        const betaHeader = req.headers["anthropic-beta"];
        const betas = (Array.isArray(betaHeader) ? betaHeader.join(",") : betaHeader ?? "").split(",").map(value => value.trim()).filter(Boolean);
        requestEvidence.push({
          optional_thinking_beta: betas.includes(optionalThinkingBeta), kept_reminder_beta: betas.includes(keptReminderBeta),
          other_betas_sha256: digest(betas.filter(value => value !== optionalThinkingBeta && value !== keptReminderBeta).sort()),
          sequence: captured.length, body_sha256: createHash("sha256").update(raw).digest("hex"),
          stream: body.stream === true, stream_field_present: Object.hasOwn(body, "stream"),
          frozen_model: body.model === "claude-sonnet-4-5", max_tokens: body.max_tokens,
          messages_sha256: digest(body.messages), system_sha256: digest(body.system), tools_sha256: digest(body.tools),
          message_count: body.messages?.length, tool_count: body.tools?.length,
          sdk_retry_count: /^\d{1,3}$/u.test(String(req.headers["x-stainless-retry-count"])) ? Number(req.headers["x-stainless-retry-count"]) : null,
          sdk_helper_stream: req.headers["x-stainless-helper-method"] === "stream",
          tool_results: results.map((block: any) => {
            const value = typeof block.content === "string" ? block.content : Array.isArray(block.content)
              ? block.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
            return { is_error: block.is_error === true, text_bytes: Buffer.byteLength(value), text_sha256: digest(value),
              exact_sentinel: value.trim() === sentinel, model_result_matches: value === expectedModelToolText, contains_sentinel: value.includes(sentinel),
              stdout_tag: value.includes("<stdout>"), stderr_tag: value.includes("<stderr>"),
              system_reminder_tag: value.includes("<system-reminder>"), persisted_output_tag: value.includes("<persisted-output>") };
          }),
        });
      }
      const local = `http://127.0.0.1:${(policy.server.address() as AddressInfo).port}`;
      const forwarded = http.request(local + req.url, { method: req.method, headers: req.rawHeaders }, reply => {
        if (route === "/gateway/v1/messages") policyStatuses.push(reply.statusCode!);
        const response: Buffer[] = [];
        res.writeHead(reply.statusCode!, reply.headers);
        reply.on("data", chunk => { response.push(Buffer.from(chunk)); res.write(chunk); });
        reply.on("end", () => {
          if (reply.statusCode === 400) {
            try {
              assert.equal(reply.headers["x-should-retry"], "false");
              policyErrors.push(JSON.parse(Buffer.concat(response).toString("utf8")).error.code);
            }
            catch { errors.push("invalid-policy-refusal"); }
          }
          res.end();
        });
        reply.on("error", () => { errors.push("capture-response"); res.destroy(); });
      });
      forwarded.on("error", () => { errors.push("capture-forward"); res.destroy(); });
      forwarded.end(raw);
    })().catch(() => { errors.push("capture-contract"); res.writeHead(500).end(); });
  });
  try {
    const interfaces = Object.values(networkInterfaces()).flatMap(entries => entries ?? []);
    assert.ok(interfaces.length > 0 && interfaces.every(entry => entry.internal), "acceptance container must expose only loopback interfaces");
    const fixture = JSON.parse(await readFile("/acceptance/runtime-fixture.json", "utf8")) as { policySource: string; encodedInput: string };
    assert.equal(typeof fixture.policySource, "string"); assert.ok(fixture.policySource.length > 0);
    assert.equal(typeof fixture.encodedInput, "string"); assert.ok(fixture.encodedInput.endsWith("\n"));
    const version = await run("claude", ["--version"], { timeout: 30_000 });
    assert.match(version.stdout, /^2\.1\.312\b/u, "execute the production pinned CLI");
    stage = "prepare-native-launch";
    const script = path.join(dir, "policy.mjs");
    await writeFile(script, fixture.policySource);
    const api = await import(pathToFileURL(script).href);
    const upstream = await listen(remote);
    policy = await api.startModelRequestPolicy({ upstream: upstream + "/gateway", token, port: 0 });
    const captureUrl = await listen(capture);
    const home = path.join(dir, "home");
    const config = path.join(home, ".claude");
    await mkdir(config, { recursive: true });
    const settings = { apiKeyHelper: "node /opt/deepsonar/dsh/deepsonar-claude-key.mjs" };
    await writeFile(path.join(config, "settings.json"), JSON.stringify(settings));
    const prepared = await api.prepareClaudeLaunch(
      "claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions --model claude-sonnet-4-5 --tools Bash --no-session-persistence",
      { DEEPSONAR_REQUEST_POLICY_UPSTREAM: upstream + "/gateway", ...privateAuth.environment,
        HOME: home, CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: captureUrl + "/gateway",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
        MAX_THINKING_TOKENS: "0" }, [settings]);
    assert.equal(prepared.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "4096");
    stage = "native-cli-tool-loop";
    cli = spawn("/bin/bash", ["-c", `mkdir -p "$CLAUDE_CONFIG_DIR" && exec ${prepared.command}`], {
      cwd: "/tmp", env: { ...process.env, ...prepared.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutPending = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2 * 1024 * 1024) { errors.push("bounded-cli-output"); cli?.kill("SIGKILL"); }
    };
    cli.stdout!.on("data", (chunk: Buffer) => {
      collect(chunk); stdoutPending += chunk.toString("utf8");
      const lines = stdoutPending.split("\n"); stdoutPending = lines.pop()!;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "user" && Array.isArray(event.message?.content)
            && event.message.content.some((block: any) => block.type === "tool_result" && block.tool_use_id === "synthetic-bash-tool")
            && event.tool_use_result && typeof event.tool_use_result === "object") nativeToolResults.push(event.tool_use_result);
          if (event.type === "result") { resultReceived = true; resultError = event.is_error === true; cli?.stdin?.end(); }
        } catch { /* Non-JSON diagnostics remain captured. */ }
      }
    });
    cli.stderr!.on("data", collect);
    const finished = new Promise<void>((resolve, reject) => {
      cli!.once("error", () => reject(new Error("Claude process failed to start")));
      cli!.once("close", (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
    });
    cli.stdin!.on("error", () => { errors.push("cli-stdin"); });
    cli.stdin!.write(fixture.encodedInput);
    await Promise.race([finished, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Pinned Claude did not finish the offline budget-refusal turn")), 120_000);
      timer.unref(); finished.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
    stage = "assert-captured-native-requests";
    assert.deepEqual(errors, []);
    assert.equal(captured.length, 3, "one initial stream, one tool continuation and one optional-beta compatibility attempt");
    const requestBodies = captured.map(raw => JSON.parse(raw.toString("utf8")));
    assert.deepEqual(requestBodies.map(body => body.stream === true), [true, true, true]);
    // Locked CW and R6/onError each have a one-shot compatibility path before
    // ordinary HTTP retry classification. Prove precisely one known removal;
    // no added marker, unrelated beta change or body regeneration is accepted.
    const markerFields = ["optional_thinking_beta", "kept_reminder_beta"];
    const removed = markerFields.filter(field => requestEvidence[1][field] === true && requestEvidence[2][field] === false);
    assert.equal(removed.length, 1, "exactly one source-verified compatibility beta must be removed");
    for (const field of markerFields.filter(field => field !== removed[0])) assert.equal(requestEvidence[2][field], requestEvidence[1][field]);
    compatibilityBranch = removed[0] === "optional_thinking_beta" ? "thinking-token-count" : "kept-reminder-clear-at";
    assert.equal(requestEvidence[2].other_betas_sha256, requestEvidence[1].other_betas_sha256);
    assert.deepEqual(requestEvidence.slice(1).map(row => row.sdk_retry_count), [0, 0]);
    assert.equal(requestEvidence[2].body_sha256, requestEvidence[1].body_sha256, "compatibility retry preserves every request body byte");
    for (const field of ["messages", "system", "tools"]) {
      const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
      assert.equal(hash(requestBodies[2][field]), hash(requestBodies[1][field]), `optional-beta compatibility attempt preserves ${field}`);
    }
    assert.equal(resultReceived, true, "CLI emits its native terminal result before stdin closes");
    assert.equal(resultError, true, "budget refusal must terminate as a native error, not successful completion");
    // Locked 2.1.312 runHeadless maps result.is_error to shutdownSync(1).
    assert.equal(exitCode, 1, "native error result must exit with the pinned CLI error code");
    assert.equal(exitSignal, null, "signal termination cannot satisfy native error completion");
    assert.equal(delivered.length, 1);
    assert.equal(nativeToolResults.length, 1, "exactly one correlated native Bash result");
    assert.equal(typeof nativeToolResults[0].stdout, "string");
    assert.ok((nativeToolResults[0].stdout as string).trim() === sentinel, "native Bash stdout is exactly the fixture sentinel");
    assert.ok(nativeToolResults[0].stderr === "", "do not hide Bash errors or environment warnings");
    assert.equal(nativeToolResults[0].interrupted, false);
    for (const field of ["backgroundTaskId", "timedOutAfterMs", "rawOutputPath", "persistedOutputPath"]) {
      assert.ok(nativeToolResults[0][field] === undefined, `tiny synchronous printf must not require ${field}`);
    }
    assert.equal(createHash("sha256").update(captured[0]!).digest("hex"), createHash("sha256").update(delivered[0]!).digest("hex"), "formed request bytes preserved");
    for (const raw of captured.slice(1)) {
      const body = JSON.parse(raw.toString("utf8"));
      assert.ok(body.model === "claude-sonnet-4-5", "native recovery retains the frozen model");
      assert.equal(body.max_tokens, 4096, "running CLI retains its launch cap");
      const result = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .find((block: any) => block.type === "tool_result" && block.tool_use_id === "synthetic-bash-tool");
      assert.ok(result, "follow-up includes the real Bash execution result");
      assert.notEqual(result.is_error, true, "Bash must execute successfully, not merely echo a rejected command");
      const text = typeof result.content === "string" ? result.content
        : result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      assert.ok(text === expectedModelToolText, "model-visible result must equal native stdout plus the exact locked total_tokens reminder");
    }
    assert.deepEqual(policyStatuses, [200, ...captured.slice(1).map(() => 400)]);
    assert.deepEqual(policyErrors, captured.slice(1).map(() => refusal));
    assert.ok(output.includes(refusal), "CLI must display the admission refusal code");
    assert.ok(output.includes("Configure supported CLI options before generating a new request")
      && output.includes("the formed request was not rewritten or sent"), "CLI must display the clear budget refusal hint");
    assert.ok(allowanceQueries >= 3, "launch and each model request query fresh allowance");
    t.diagnostic(JSON.stringify({ cli: "2.1.312", model_requests: captured.length, upstream_requests: delivered.length,
      auxiliary_calls: auxiliaryCalls, allowance_queries: allowanceQueries, refusal_visible: true, exit_code: exitCode, ...progressEvidence(),
      request_shapes: requestEvidence, first_body_sha256: createHash("sha256").update(delivered[0]!).digest("hex") }));
  } catch (error) {
    const category = /unknown option|unrecognized option|invalid option/iu.test(output) ? "unknown-option"
      : /not logged in|invalid api key|authentication|login required/iu.test(output) ? "authentication"
      : /cannot be used with root|root privileges|permission denied/iu.test(output) ? "permission"
      : output.includes(refusal) ? "admission-refusal"
      : stage === "image-version" ? "image-version"
      : exitCode === null ? "timeout-or-startup" : "unclassified-cli-failure";
    t.diagnostic(JSON.stringify({ stage, category, exit_code: exitCode, exit_signal: exitSignal, error: error instanceof Error ? error.name : "UnknownError",
      model_requests: captured.length, upstream_requests: delivered.length, auxiliary_calls: auxiliaryCalls, policy_statuses: policyStatuses, request_shapes: requestEvidence, ...progressEvidence() }));
    throw error;
  } finally {
    cli?.kill("SIGKILL");
    await close(capture); await policy?.close(); await close(remote);
    await rm(dir, { recursive: true, force: true });
  }
});
