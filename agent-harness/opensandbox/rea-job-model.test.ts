import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startReaJobModel } from "./rea-job-model.js";

async function post(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

test("REA loopback model runs actor then ends after successful tool result", async () => {
  const model = await startReaJobModel();
  try {
    const first = await post(`${model.url}/v1/messages`, { model: "claude-sonnet-4-5", stream: false, messages: [] });
    assert.equal(first.stop_reason, "tool_use");
    assert.equal(first.content[0]?.name, "Bash");
    assert.match(first.content[0]?.input?.command ?? "", /rea-job-actor\.py/);

    const second = await post(`${model.url}/v1/messages`, {
      model: "claude-sonnet-4-5",
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_rea_e2e", content: "REA_E2E_DONE\nExit code 0" }],
      }],
    });
    assert.equal(second.stop_reason, "end_turn");
    assert.match(second.content[0]?.text ?? "", /Control API/);
  } finally {
    await model.close();
  }
});

test("REA loopback model reports actor failure without mark_job_done", async () => {
  const model = await startReaJobModel();
  try {
    await post(`${model.url}/v1/messages`, { model: "claude-sonnet-4-5", stream: false, messages: [] });
    const report = await post(`${model.url}/v1/messages`, {
      model: "claude-sonnet-4-5",
      stream: false,
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_rea_e2e",
          is_error: true,
          content: "Exit code 1 AssertionError: restricted sandbox leaked arbitrary internet egress",
        }],
      }],
    });
    assert.equal(report.stop_reason, "tool_use");
    assert.equal(report.content[0]?.id, "toolu_rea_fail_report");
    assert.match(report.content[0]?.input?.command ?? "", /REA_ACTOR_FAILED|emit_progress|base64/);

    const final = await post(`${model.url}/v1/messages`, {
      model: "claude-sonnet-4-5",
      stream: false,
      messages: [
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_rea_e2e",
            is_error: true,
            content: "Exit code 1 AssertionError: restricted sandbox leaked arbitrary internet egress",
          }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_rea_fail_report", content: "Exit code 1" }],
        },
      ],
    });
    assert.equal(final.stop_reason, "end_turn");
    assert.match(final.content[0]?.text ?? "", /refusing mark_job_done/);
  } finally {
    await model.close();
  }
});

// Execute only the actual request builders: no actor workload, sandbox, or model.
// Capturing urllib Requests also covers Python's case-normalized header names.
test("sandbox actors and PoCs send revision zero only on initial completion", () => {
  const script = String.raw`
import ast, contextlib, io, json, os, pathlib, sys, urllib.error, urllib.request, uuid
root = pathlib.Path(sys.argv[1])
os.environ['DEEPSONAR_API_BASE_URL'] = 'http://offline.invalid/control/v1/jobs/test'
os.environ['DEEPSONAR_API_TOKEN'] = 'offline-contract-token'
requests = []
class Response(io.BytesIO):
    status = 200
def capture(request, **kwargs):
    requests.append({'source': source, 'operation': request.full_url.rsplit('/', 1)[-1],
                     'headers': dict(request.header_items()), 'body': json.loads(request.data)})
    return Response(b'{"accepted":true}')
urllib.request.urlopen = capture
for source in ['rea-job-actor.py', 'knowledge-job-actor.py', 'opensandbox-platform-api.poc.ts', 'opensandbox-cli-control.poc.ts']:
    text = (root / source).read_text()
    namespace = dict(globals())
    if source.endswith('.py'):
        tree = ast.parse(text)
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'invoke']
        exec(compile(ast.Module(body=functions, type_ignores=[]), source, 'exec'), namespace)
        namespace['invoke']('emit_progress', {'message': 'offline contract'})
        namespace['invoke']('mark_job_done', {'summary': 'Offline completion contract.'})
        if source == 'rea-job-actor.py':
            verify = next(node for node in tree.body if isinstance(node, ast.If))
            done = next(node for node in verify.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                        and isinstance(node.value.func, ast.Name) and node.value.func.id == 'invoke'
                        and ast.literal_eval(node.value.args[0]) == 'mark_job_done')
            # Execute the real negative probe call, preserving its overclaim.
            exec(compile(ast.Module(body=[done], type_ignores=[]), source, 'exec'), namespace)
    elif source == 'opensandbox-platform-api.poc.ts':
        code = text[text.index('def http('):text.index('print("GW:')]
        exec(code, namespace)
        for operation in ['emit_fact', 'mark_job_done']:
            assert namespace['post'](operation, {'summary': 'Offline completion contract.'}, 'offline-contract-token') == 200
    else:
        code = text.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        for operation in ['emit_fact', 'mark_job_done']:
            sys.argv = ['offline', os.environ['DEEPSONAR_API_BASE_URL'], 'offline-contract-token', operation,
                        '{"summary":"Offline completion contract."}']
            with contextlib.redirect_stdout(io.StringIO()):
                exec(code, namespace)
print(json.dumps(requests))
`;
  const requests = JSON.parse(execFileSync("python3", ["-c", script, fileURLToPath(new URL(".", import.meta.url))], {
    encoding: "utf8", timeout: 10_000,
  })) as Array<{ source: string; operation: string; headers: Record<string, string>; body: { verdict?: string } }>;
  assert.equal(requests.length, 9);
  for (const request of requests) {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(headers["x-deepsonar-proposal-revision"], request.operation === "mark_job_done" ? "0" : undefined, request.source);
    assert.equal(headers.authorization, "Bearer offline-contract-token");
    assert.match(headers["idempotency-key"] ?? "", /^[0-9a-f-]{36}$/);
  }
  assert.equal(new Set(requests.map((request) => request.headers["Idempotency-key"])).size, requests.length);
  assert.equal(requests.filter((request) => request.body.verdict === "confirmed").length, 1,
    "Verify must still propose confirmed so the production evidence gate can downgrade it to rework");
});
