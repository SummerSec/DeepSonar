export const PI_MAIN_REQUEST_BUDGET_PATH = "/workspace/.deepsonar-home/.pi/agent/extensions/deepsonar-main-request-budget.mjs";

/** Shared by SDK request generators; these fields are the pinned SDK's actual branches. */
export const PI_ANTHROPIC_THINKING_POLICY_SOURCE = String.raw`
export function assertPiAnthropicThinkingBudget(model, options, effectiveMaxTokens) {
  if (model.api !== 'anthropic-messages' || !model.reasoning || !options?.reasoning
    || model.compat?.forceAdaptiveThinking === true || model.compat?.supportsMidConvoEffort === true) return;
  const level = ['xhigh','max'].includes(options.reasoning) ? 'high' : options.reasoning;
  const budget = Object.prototype.hasOwnProperty.call(options.thinkingBudgets ?? {}, level)
    ? options.thinkingBudgets[level] : ({ minimal:1024, low:2048, medium:8192, high:16384 })[level];
  // The SDK reserves 1024 answer tokens, then uses budget || 1024 in the payload.
  // Reject before generation rather than disabling thinking or repairing its payload.
  if (!Number.isSafeInteger(budget) || budget < 1024 || effectiveMaxTokens < 2048)
    throw new Error('PI_MAIN_BUDGET_THINKING_MINIMUM');
}
`;

/** Pi 1.4.0's public provider streamSimple extension runs before SDK HTTP generation. */
export const PI_MAIN_REQUEST_BUDGET_SOURCE = String.raw`
import { createAssistantMessageEventStream, streamSimple as sdkStreamSimple } from '@earendil-works/pi-ai/compat';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

${PI_ANTHROPIC_THINKING_POLICY_SOURCE}

// Resolve the SDK's declared public export from the fixed, lockfile-installed runtime.
// createRequire.resolve cannot resolve this package's import-only export conditions.
export async function loadPiContextClamp(root = '/opt/deepsonar/dsh/node_modules/@earendil-works/pi-ai') {
  const manifest = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  if (manifest.name !== '@earendil-works/pi-ai' || manifest.version !== '1.4.0') fail('PI_MAIN_BUDGET_SDK_VERSION');
  const entry = manifest.exports?.['./api/*']?.import;
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) fail('PI_MAIN_BUDGET_SDK_EXPORT');
  const sdk = await import(pathToFileURL(root + '/' + entry.replace('*','simple-options')).href);
  if (typeof sdk.clampMaxTokensToContext !== 'function') fail('PI_MAIN_BUDGET_SDK_EXPORT');
  return sdk.clampMaxTokensToContext;
}
let contextClamp;


const SUPPORTED = new Set(['anthropic-messages','openai-completions','openai-responses']);
const OM_PROVIDER = '__deepsonar_observational_memory';
// Only the host allowance response can create this signal; SDK error text cannot.
const completionAlreadyAccepted = new Error('COMPLETION_ALREADY_ACCEPTED');
function fail(code) { throw new Error(code); }
function endpoint(value) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('PI_MAIN_BUDGET_ROUTE_INVALID');
  return url.href.replace(/\/+$/, '');
}

export async function readMainAllowance(baseUrl, token, requestSignal) {
  const signal = AbortSignal.any([...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(15_000)]);
  for (;;) {
    const response = await fetch(endpoint(baseUrl) + '/_allowance', {
      headers: { authorization: 'Bearer ' + token }, redirect: 'manual', signal,
    });
    const chunks = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) { await response.body.cancel().catch(() => {}); fail('PI_MAIN_BUDGET_ALLOWANCE_INVALID'); }
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('PI_MAIN_BUDGET_ALLOWANCE_INVALID'); }
    if (response.status === 409 && ['JOB_TOKEN_USAGE_PENDING','REPAIR_USAGE_PENDING'].includes(value?.error?.type)) {
      await delay(100, undefined, { signal }); continue;
    }
    if (response.status === 409 && value?.error?.type === 'COMPLETION_ALREADY_ACCEPTED') throw completionAlreadyAccepted;
    if (response.status !== 200) fail('PI_MAIN_BUDGET_ALLOWANCE_DENIED');
    if (typeof value?.policy_required !== 'boolean' || (value.remaining_tokens !== null
      && (!Number.isSafeInteger(value.remaining_tokens) || value.remaining_tokens < 0))) fail('PI_MAIN_BUDGET_ALLOWANCE_INVALID');
    return value;
  }
}

// This authenticated, host-owned route never forwards a provider response. Error
// prose/status and provider-supplied headers are not no-start evidence.
export async function readGatewayNoStart(baseUrl, token, requestId, requestSignal) {
  const signal = AbortSignal.any([...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(15_000)]);
  try {
    const response = await fetch(endpoint(baseUrl) + '/_settlement/' + requestId, {
      headers: { authorization: 'Bearer ' + token }, redirect: 'manual', signal,
    });
    if (response.status !== 200) { await response.body?.cancel(); return false; }
    const chunks = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) return false;
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value?.status === 'not_started' && value.reason === 'gateway_transient';
  } catch { return false; }
}

/** SDK inputs only: no onPayload callback, fetch interception or serialized body editing. */
export function preparePiMainSdkRequest(model, options, allowance) {
  if (!SUPPORTED.has(model.api)) fail('PI_MAIN_BUDGET_PROTOCOL_UNSUPPORTED');
  if (!allowance.policy_required) return { model, options };
  const remaining = allowance.remaining_tokens;
  if (remaining === 0) fail('PI_MAIN_BUDGET_EXHAUSTED');
  const requested = options?.maxTokens ?? model.maxTokens;
  if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) fail('PI_MAIN_BUDGET_OUTPUT_INVALID');
  const limit = Math.min(requested, model.maxTokens, remaining ?? Infinity);
  assertPiAnthropicThinkingBudget(model, options, limit);
  if (model.api === 'openai-responses' && (limit < 16 || model.compat?.supportsMaxOutputTokens === false)) fail('PI_MAIN_BUDGET_PROTOCOL_LIMIT');
  if (model.api === 'openai-completions' && model.compat?.supportsUsageInStreaming === false) fail('PI_MAIN_BUDGET_STREAM_USAGE_UNSUPPORTED');
  // These optional SDK sampling maps are merged after maxTokens by the pinned SDK.
  // Conflicting overrides require an explicit configuration change, never body rewriting.
  const sampling = [model.samplingParams, options?.samplingParams, ...Object.values(model.samplingParamsByThinkingLevel ?? {})];
  for (const params of sampling) if (params && ['max_tokens','max_completion_tokens','max_output_tokens','stream_options','n','best_of']
    .some(key => Object.prototype.hasOwnProperty.call(params,key))) fail('PI_MAIN_BUDGET_SAMPLING_CONFLICT');
  const selected = { ...model, maxTokens: limit };
  if (model.api === 'openai-completions') selected.compat = { ...model.compat, supportsUsageInStreaming: true };
  return { model: selected, options: { ...options, maxTokens: limit, maxRetries: 0 } };
}

export function createPiMainRequestBudgetExtension(env = process.env, delegate = sdkStreamSimple) {
  const gateway = endpoint(env.DEEPSONAR_REQUEST_POLICY_UPSTREAM);
  const token = env.DEEPSONAR_GATEWAY_TOKEN;
  if (typeof token !== 'string' || !token) fail('PI_MAIN_BUDGET_TOKEN_MISSING');
  return function install(pi) {
    let identity;
    let registered;
    pi.on('session_start', (_event, ctx) => {
      const model = ctx.model;
      if (!model || model.provider === OM_PROVIDER || !SUPPORTED.has(model.api)) fail('PI_MAIN_BUDGET_PROTOCOL_UNSUPPORTED');
      const next = { provider: model.provider, id: model.id, api: model.api, baseUrl: endpoint(model.baseUrl) };
      if (identity && JSON.stringify(identity) !== JSON.stringify(next)) fail('PI_MAIN_BUDGET_MODEL_CHANGED');
      identity = next;
      const previous = ctx.modelRegistry.getRegisteredProviderConfig?.(identity.provider);
      if (previous?.streamSimple && previous.streamSimple !== registered) fail('PI_MAIN_BUDGET_PROVIDER_CONFLICT');
      registered ??= (requestedModel, context, options) => {
        const output = createAssistantMessageEventStream();
        void (async () => {
          try {
            if (requestedModel.provider !== identity.provider || requestedModel.id !== identity.id
              || requestedModel.api !== identity.api || endpoint(requestedModel.baseUrl) !== identity.baseUrl) fail('PI_MAIN_BUDGET_MODEL_CHANGED');
            if (options?.apiKey !== undefined && options.apiKey !== token) fail('PI_MAIN_BUDGET_AUTH_MISMATCH');
            let retryOf;
            // Local loop bound is not a grant: admission enforces the original
            // frozen Job-wide cap across requests, tokens and Attempts.
            for (let retries = 0; retries <= 2; retries++) {
              const allowance = await readMainAllowance(gateway, token, options?.signal);
              const prepared = preparePiMainSdkRequest(requestedModel, options, allowance);
              if (allowance.policy_required && requestedModel.api === 'anthropic-messages' && requestedModel.reasoning && options?.reasoning
                && requestedModel.compat?.forceAdaptiveThinking !== true && requestedModel.compat?.supportsMidConvoEffort !== true) {
                contextClamp ??= loadPiContextClamp();
                const clamp = await contextClamp;
                assertPiAnthropicThinkingBudget(prepared.model, prepared.options, clamp(prepared.model, context, prepared.options.maxTokens));
              }
              const requestId = randomUUID();
              const headers = Object.fromEntries(Object.entries(prepared.options?.headers ?? {})
                .filter(([name]) => !['x-deepsonar-request-id','x-deepsonar-retry-of'].includes(name.toLowerCase())));
              headers['x-deepsonar-request-id'] = requestId;
              if (retryOf) headers['x-deepsonar-retry-of'] = retryOf;
              let failure, pendingStart, visible = false;
              for await (const event of delegate(prepared.model, context,
                { ...prepared.options, headers, maxRetries: 0, apiKey: token })) {
                if (event.type === 'error') {
                  if (event.error?.content?.length) visible = true;
                  if (failure) {
                    if (pendingStart) { output.push(pendingStart); pendingStart = undefined; }
                    visible = true; output.push(failure);
                  }
                  failure = event; continue;
                }
                if (event.type === 'start' && !visible && !failure && !pendingStart && !event.partial?.content?.length) {
                  pendingStart = event; continue;
                }
                if (pendingStart) { output.push(pendingStart); pendingStart = undefined; }
                if (failure) { output.push(failure); failure = undefined; visible = true; }
                if (event.type !== 'start' || event.partial?.content?.length) visible = true;
                output.push(event);
              }
              if (!failure) { if (pendingStart) output.push(pendingStart); break; }
              if (visible || retries >= 2 || options?.signal?.aborted
                || !await readGatewayNoStart(gateway, token, requestId, options?.signal)) {
                if (pendingStart) output.push(pendingStart);
                output.push(failure); break;
              }
              // Do not publish a second message_start for a generation that never ran.
              retryOf = requestId;
              await delay(100 * (2 ** retries), undefined, { signal: options?.signal });
            }
          } catch (error) {
            const code = error === completionAlreadyAccepted ? completionAlreadyAccepted.message
              : /^PI_MAIN_BUDGET_/.test(error?.message ?? '') ? error.message : 'PI_MAIN_BUDGET_REQUEST_FAILED';
            output.push({ type: 'error', reason: 'error', error: {
              role: 'assistant', content: [], api: requestedModel.api, provider: requestedModel.provider, model: requestedModel.id,
              usage: { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} },
              stopReason:'error', errorMessage:code, timestamp:Date.now(),
            } });
          } finally { output.end(); }
        })();
        return output;
      };
      // Public per-provider override. Existing catalog/auth/headers remain on this
      // provider; OM has its own provider and never enters this main-workload wrapper.
      pi.registerProvider(identity.provider, { api: identity.api, streamSimple: registered });
    });
  };
}
export default function mainRequestBudget(pi) { return createPiMainRequestBudgetExtension()(pi); }
`;
