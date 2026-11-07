// Run with tsx: imports the actual production profile, never a parallel fixture profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDshProfilePatch, DSH_PROFILE, DSH_PROFILE_MANIFEST } from '../packages/runtime-sandbox/src/dsh-profile.ts';
import { DSH_REQUEST_BUDGET_PLUGIN } from '../packages/runtime-sandbox/src/dsh-request-budget.ts';
import { DSH_REQUEST_BUDGET_IMAGE_GUARD_SOURCE } from '../packages/runtime-sandbox/src/dsh-runtime-image-guard.ts';
import { installDshRequestBudget } from './dsh-request-budget-install.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = resolve(process.env.DSH_REQUEST_BUDGET_INSTALL_ROOT ?? join(repository, 'agent-harness/dsh-runtime'));
const bin = join(installRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.equal(JSON.parse(await readFile(join(installRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, '0.2.1-rc.2');
const artifact = await installDshRequestBudget(installRoot, join(repository, 'packages/runtime-sandbox/src'));
// #979: execute the production preflight against the real, pinned installation,
// without a model request. Substitute only the filesystem root used by this CI fixture.
const imageGuard = DSH_REQUEST_BUDGET_IMAGE_GUARD_SOURCE.replaceAll('/opt/deepsonar/dsh', () => JSON.stringify(installRoot).slice(1, -1));
const checkImage = () => spawnSync(process.execPath, ['-e', imageGuard], { encoding: 'utf8' });
const readyImage = checkImage();
assert.equal(readyImage.status, 0, readyImage.stderr);
const governedBytes = await readFile(artifact);
try {
  await rm(artifact);
  const missing = checkImage();
  assert.equal(missing.status, 78);
  assert.match(missing.stderr, /DSH_REQUEST_BUDGET_IMAGE_CONTENT_INVALID/);
} finally {
  await writeFile(artifact, governedBytes);
}
assert.equal(checkImage().status, 0);
const root = await mkdtemp(join(tmpdir(), 'deepsonar-dsh-budget-cli-'));
const provider = 'synthetic-dsh';
const model = 'synthetic-cli-model';
const token = 'synthetic-cli-job-token';
const records = [], requests = [], grants = [], errors = [];
let phase = 'tools', count = 0, remaining = 3000, overflowSent = false;
let lifecycleOrder = 0, cancellationClosedOrder;
let childGateResolve, heldAllowanceResolve, cancelledAllowanceResolve;
let childGate = new Promise(resolve => { childGateResolve = resolve; });
let heldAllowance = new Promise(resolve => { heldAllowanceResolve = resolve; });
let cancelledAllowance = new Promise(resolve => { cancelledAllowanceResolve = resolve; });
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === '/gateway/_allowance') {
      if (phase === 'cancel') {
        res.once('close', () => { if (!res.writableEnded) { cancellationClosedOrder = ++lifecycleOrder; cancelledAllowanceResolve(); } });
        heldAllowanceResolve();
        return; // Hold admission until native shutdown; this fixture proves teardown only, not live-process abort.
      }
      remaining -= 73;
      grants.push({ cap: remaining, consumed: false, phase });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ remaining_tokens: remaining, policy_required: true }));
      return;
    }
    assert.equal(req.url, '/gateway/chat/completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, model);
    assert.equal(body.stream_options.include_usage, true);
    const cap = body.max_tokens ?? body.max_completion_tokens;
    const grant = grants.find(value => !value.consumed && value.cap === cap);
    assert.ok(grant, `SDK request without its exact current allowance: ${cap}`);
    grant.consumed = true;
    const text = JSON.stringify(body.messages);
    const summary = text.includes('You are now acting as a compaction engine');
    const child = phase === 'subagent' && body.messages.some(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.startsWith('synthetic-child-request'));
    requests.push({ phase, cap, summary, child, body });
    if (phase === 'compaction' && !summary && !overflowSent) {
      overflowSent = true;
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
        message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded',
      } }));
      return;
    }
    if (child) await childGate;
    const tool = !summary && !child && ['tools', 'subagent'].includes(phase) && count++ === 0;
    let delta;
    if (tool) {
      const name = phase === 'tools' ? 'bash' : 'subagent';
      assert.ok(body.tools.some(value => value.function.name === name));
      const args = phase === 'tools'
        ? { command: 'printf synthetic-tool-completed', description: 'Run isolated synthetic tool' }
        : { description: 'Verify governed child request', prompt: 'synthetic-child-request' };
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `synthetic-${phase}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    } else {
      if (phase === 'tools') assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('synthetic-tool-completed')));
      delta = { role: 'assistant', content: summary ? '## Primary Request and Intent\n- Continue synthetic verification.\n## Current Work\n- Tools completed.\n## Next Step\n- Answer the user.' : child ? 'synthetic-child-completed' : `synthetic-${phase}-completed` };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = { id: 'synthetic-cli', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(packet)}\n\n`);
    packet.choices = [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }];
    packet.usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    res.write(`data: ${JSON.stringify(packet)}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error);
    res.writeHead(500).end('synthetic fixture assertion failed');
  }
});

async function launch(baseUrl, label) {
  const cwd = join(root, label, 'workspace'), home = join(root, label, 'home');
  const profile = join(home, 'profiles', DSH_PROFILE);
  await mkdir(cwd, { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), DSH_PROFILE_MANIFEST);
  const patch = buildDshProfilePatch({ cwd, home, governedRequestBudget: true, providerConfig: { providers: {
    [provider]: { api: 'openai-completions', apiKeyEnv: 'DEEPSONAR_GATEWAY_TOKEN', baseURL: baseUrl,
      models: [{ id: model, contextWindow: 100000, maxTokens: 4096, reasoningEfforts: false }] },
  } } });
  assert.equal(patch.split(DSH_REQUEST_BUDGET_PLUGIN).length, 2);
  // The only profile change is installation-root relocation; the production plugin tree/config is identical.
  const relocated = patch.replace(DSH_REQUEST_BUDGET_PLUGIN, artifact);
  assert.equal(relocated.replace(artifact, DSH_REQUEST_BUDGET_PLUGIN), patch);
  await writeFile(join(profile, 'cordis.patch.yml'), relocated);
  await writeFile(join(home, 'cordis.patch.yml'), '[]\n');
  const processChild = spawn(process.execPath, [bin, '--profile', DSH_PROFILE], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    DEEPSONAR_GATEWAY_TOKEN: token, DEEPSONAR_REQUEST_POLICY_UPSTREAM: baseUrl,
    DEEPSONAR_DSH_FROZEN_IDENTITY: JSON.stringify({ provider, id: model, api: 'openai-completions', baseUrl }),
  } });
  let stderr = '', buffer = '', sequence = 0;
  const pending = new Map(), waiters = new Set();
  const seen = [], children = new Set(), active = new Set();
  let lastIdle = 0, closedOrder;
  const finishError = error => { for (const item of pending.values()) item.reject(error); for (const item of waiters) item.reject(error); };
  const check = () => { for (const item of waiters) if (item.predicate()) { waiters.delete(item); item.resolve(); } };
  processChild.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  processChild.stdout.on('data', data => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const record = JSON.parse(line); records.push(record); seen.push(record);
        if (record.id && pending.has(record.id)) {
          const item = pending.get(record.id); pending.delete(record.id);
          record.error ? item.reject(new Error(JSON.stringify(record.error))) : item.resolve(record.result);
        }
        if (record.method === 'subagent.started') { children.add(record.params.childSessionId); active.add(record.params.childSessionId); }
        if (record.method === 'subagent.finished') { assert.equal(record.params.status, 'ok'); active.delete(record.params.childSessionId); }
        if (record.method === 'session.status' && record.params.sessionId === label && record.params.status === 'idle') {
          if (active.size) childGateResolve();
          else lastIdle = seen.length;
        }
        check();
      } catch (error) { finishError(error); }
    }
  });
  const exit = new Promise((resolve, reject) => {
    processChild.on('error', reject);
    processChild.on('close', code => { closedOrder = ++lifecycleOrder; code === 0 ? resolve() : reject(new Error(`DSH CLI exit ${code}: ${stderr}`)); });
  });
  exit.catch(finishError);
  const timeout = setTimeout(() => { finishError(new Error(`DSH CLI timeout: ${stderr}`)); processChild.kill('SIGKILL'); }, 60000);
  const wait = predicate => predicate() ? Promise.resolve() : new Promise((resolve, reject) => waiters.add({ predicate, resolve, reject }));
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `${label}-${++sequence}`; pending.set(id, { resolve, reject });
    processChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const prompt = async text => {
    const start = seen.length;
    await request('session/prompt', { sessionId: label, contentBlocks: [{ type: 'text', text }] });
    await wait(() => lastIdle > start);
  };
  try { await request('initialize', { cwd, provider, model }); }
  catch (error) { clearTimeout(timeout); processChild.kill('SIGKILL'); throw error; }
  return { request, prompt, seen, children, get closedOrder() { return closedOrder; }, async shutdown() { await request('shutdown', {}); await exit; clearTimeout(timeout); assert.doesNotMatch(stderr, /did not activate|startup failed|ValidationError/); }, kill() { clearTimeout(timeout); processChild.kill('SIGKILL'); } };
}

// Public session notifications prove the CLI consumed SDK usage, not Gateway ledger settlement.
function assertUsage(record) {
  assert.ok(record, 'expected usage-bearing session event');
  assert.deepEqual(record.params.event.data.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
}
let runtime, cancelling;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/gateway`;
  runtime = await launch(baseUrl, 'synthetic-main-session');
  await runtime.prompt('Run the synthetic shell tool and continue. ' + 'Synthetic historical context for real compaction. '.repeat(500));
  assert.equal(requests.filter(value => value.phase === 'tools').length, 2);
  const toolEvents = runtime.seen.filter(record => record.method === 'session.event' && record.params.event.type === 'tool/result');
  assert.ok(toolEvents.some(record => JSON.stringify(record).includes('synthetic-tool-completed')));
  const toolMessages = runtime.seen.filter(record => record.method === 'session.event' && record.params.sessionId === 'synthetic-main-session' && record.params.event.type === 'assistant/message');
  assert.equal(toolMessages.length, 2, 'tool request and continuation must both produce assistant messages');
  toolMessages.forEach(assertUsage);
  phase = 'followup'; count = 0;
  await runtime.prompt('Continue the same session with decreasing allowance.');
  const followup = requests.find(value => value.phase === 'followup');
  assert.ok(JSON.stringify(followup.body.messages).includes('synthetic-tools-completed'));
  phase = 'compaction'; count = 0;
  await runtime.prompt('Preserve prior tool work while continuing after context pressure.');
  assert.equal(overflowSent, true);
  assert.ok(requests.some(value => value.phase === 'compaction' && value.summary), 'native compaction never called its SDK summary route');
  assert.ok(requests.filter(value => value.phase === 'compaction' && !value.summary).length >= 2, 'no post-compaction retry');
  assertUsage(runtime.seen.find(record => record.method === 'session.event' && record.params.event.type === 'compaction/summary'));
  phase = 'subagent'; count = 0;
  await runtime.prompt('Delegate the synthetic child and consume its result.');
  assert.equal(runtime.children.size, 1);
  assert.ok(requests.some(value => value.child));
  assert.ok(runtime.seen.some(record => record.method === 'subagent.finished' && record.params.lastAssistantMessage?.some(block => block.type === 'text' && block.text === 'synthetic-child-completed')));
  const childMessages = runtime.seen.filter(record => record.method === 'session.event' && runtime.children.has(record.params.sessionId) && record.params.event.type === 'assistant/message');
  assert.equal(childMessages.length, 1, 'real child must publish its own SDK usage');
  childMessages.forEach(assertUsage);
  await runtime.shutdown(); runtime = undefined;
  assert.ok(grants.every(value => value.consumed), 'allowance did not reach corresponding SDK request');
  assert.ok(grants.every((value, index) => index === 0 || value.cap < grants[index - 1].cap), 'allowance grants did not decrease');
  const sequential = requests.filter(value => value.phase !== 'subagent');
  assert.ok(sequential.every((value, index) => index === 0 || value.cap < sequential[index - 1].cap), 'sequential requests failed to use decreasing balance');
  phase = 'cancel';
  cancelling = await launch(baseUrl, 'synthetic-cancel-session');
  const before = requests.length;
  await cancelling.request('session/prompt', { sessionId: 'synthetic-cancel-session', contentBlocks: [{ type: 'text', text: 'Wait for admission until shutdown.' }] });
  let admissionTimer;
  try { await Promise.race([heldAllowance, new Promise((_, reject) => { admissionTimer = setTimeout(() => reject(new Error('CLI never reached held allowance')), 10000); })]); }
  finally { clearTimeout(admissionTimer); }
  const shutdown = cancelling.shutdown();
  shutdown.catch(() => {}); // Still awaited below; cancellation assertion failures must not leak a rejection.
  let cancelTimer;
  try { await Promise.race([cancelledAllowance, new Promise((_, reject) => { cancelTimer = setTimeout(() => reject(new Error('shutdown did not close the pending allowance connection')), 5000); })]); }
  finally { clearTimeout(cancelTimer); }
  await shutdown;
  assert.ok(cancellationClosedOrder < cancelling.closedOrder, 'pending allowance connection remained open until after CLI close');
  cancelling = undefined;
  assert.equal(requests.length, before, 'cancelled admission sent provider HTTP');
  assert.deepEqual(errors, []);
  console.log(`DSH real CLI production profile passed: tools, continuation, followup, native overflow compaction, child call, native shutdown cleanup (${requests.length} SDK HTTP requests)`);
} finally {
  runtime?.kill(); cancelling?.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
