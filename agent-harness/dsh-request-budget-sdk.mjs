// CI-only real pinned DSH adapter + SDK, loopback upstream and synthetic token.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDshRequestBudget } from './dsh-request-budget-install.mjs';
const root = resolve(process.env.DSH_REQUEST_BUDGET_INSTALL_ROOT ?? 'agent-harness/dsh-runtime');
const require = createRequire(root + '/package.json');
const load = name => import(pathToFileURL(require.resolve(name)).href);
const artifact = await installDshRequestBudget(root, resolve('packages/runtime-sandbox/src'));
const { PiAiAdapter } = await import(pathToFileURL(artifact).href);
const { Context } = await load('@deepseek-ai/cordis');
const { LlmRuntime, createUserMessage } = await load('@deepseek-ai/dsh-llm');
// Public import-only SDK export: resolve from its declared package exports.
const { readFile, writeFile } = await import('node:fs/promises');
const sdkRoot = root + '/node_modules/@earendil-works/pi-ai';
const sdkManifest = JSON.parse(await readFile(sdkRoot + '/package.json', 'utf8'));
const apiEntry = sdkManifest.exports['./api/*'].import.replace('*', 'openai-completions.lazy');
const { openAICompletionsApi } = await import(pathToFileURL(sdkRoot + '/' + apiEntry).href);
const api = openAICompletionsApi();
let remaining = 80;
const requests = [];
let allowanceCount = 0;
const server = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer synthetic-dsh-token');
  if (request.url === '/gateway/_allowance') {
    allowanceCount++;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ remaining_tokens: remaining, policy_required: true }));
    return;
  }
  assert.equal(request.url, '/gateway/chat/completions');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push(body);
  assert.equal(body.model, 'synthetic-model');
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(body.max_tokens ?? body.max_completion_tokens, remaining);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'synthetic reply' }, finish_reason: null }] }) + '\n\n');
  response.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }) + '\n\n');
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port + '/gateway';
const model = Object.freeze({ provider: 'synthetic', id: 'synthetic-model', name: 'synthetic-model', api: 'openai-completions', baseUrl,
  input: ['text'], reasoning: false, contextWindow: 100000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
process.env.DEEPSONAR_DSH_FROZEN_IDENTITY = JSON.stringify(model);
process.env.DEEPSONAR_GATEWAY_TOKEN = 'synthetic-dsh-token';
process.env.DEEPSONAR_REQUEST_POLICY_UPSTREAM = baseUrl;
const provider = { id: model.provider, name: model.provider, baseUrl, getModels: () => [model],
  auth: { apiKey: { name: 'synthetic', resolve: async ({ credential }) => ({ auth: { apiKey: credential.key }, source: 'synthetic' }) } },
  stream: (m, c, o) => api.stream(m, c, o), streamSimple: (m, c, o) => api.streamSimple(m, c, o) };
const profiles = new Map([[model.provider, { provider: model.provider, displayName: model.provider, api: model.api, baseURL: baseUrl,
  streamIdleTimeoutMs: 5000, transport: 'sse', configuredMaxTokens: new Map(), modelErrors: new Map(), piProvider: provider }]]);
const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-dsh-token',
  auth: { credentials: { read: async () => undefined, list: async () => [] }, authContext: { env: async () => undefined } } });
const ctx = new Context();
try {
  await ctx.plugin(LlmRuntime).await();
  ctx.llm.registerAdapter(['synthetic'], adapter);
  const options = { provider: 'synthetic', model: 'synthetic-model', maxTokens: 128,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'synthetic input' }], source: 'user' })], tools: [] };
  const consume = async stream => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(chunks.some(chunk => JSON.stringify(chunk).includes('synthetic reply')), JSON.stringify(chunks));
    assert.ok(!chunks.some(chunk => chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason)), JSON.stringify(chunks));
  };
  // Main prepared call and direct service call used by compaction share registration.
  const prepared = await ctx.llm.prepareCall({ provider: options.provider, model: options.model, maxTokens: options.maxTokens });
  await consume(prepared.stream({ ...options, ...prepared.config }));
  remaining = 32;
  await consume(ctx.llm.stream(options));
  assert.equal(requests.length, 2);
  assert.equal(allowanceCount, 2);
  assert.equal(model.maxTokens, 256);
  // Models.applyAuth runs after initial admission. A provider's auth resolver
  // must not redirect the final model or replace the bound credential.
  const originalAuth = provider.auth.apiKey.resolve;
  provider.auth.apiKey.resolve = async ({ credential }) => ({ auth: { apiKey: credential.key, baseUrl: baseUrl + '/other' }, source: 'synthetic' });
  const redirected = [];
  for await (const chunk of ctx.llm.stream(options)) redirected.push(chunk);
  assert.equal(requests.length, 2);
  assert.ok(redirected.some(chunk => JSON.stringify(chunk).includes('DSH_BUDGET_MODEL_CHANGED')), JSON.stringify(redirected));
  provider.auth.apiKey.resolve = originalAuth;
  remaining = 0;
  const denied = [];
  for await (const chunk of ctx.llm.stream(options)) denied.push(chunk);
  assert.equal(requests.length, 2);
  assert.ok(denied.some(chunk => JSON.stringify(chunk).includes('BUDGET_EXHAUSTED')), JSON.stringify(denied));
  console.log('DSH registered main/direct service requests passed real SDK synthetic-upstream checks');
} finally {
  await ctx.fiber.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const helperPath = root + '/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/deepsonar-request-budget.mjs';
const originalHelper = await readFile(helperPath);
try {
  await writeFile(helperPath, Buffer.concat([originalHelper, Buffer.from('\n// synthetic integrity mismatch\n')]));
  await assert.rejects(import(pathToFileURL(artifact).href + '?integrity-negative'), /DSH_BUDGET_ARTIFACT_INTEGRITY/);
} finally {
  await writeFile(helperPath, originalHelper);
}
