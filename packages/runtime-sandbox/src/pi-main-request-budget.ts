export const PI_MAIN_REQUEST_BUDGET_PATH = "/workspace/.deepsonar-home/.pi/agent/extensions/deepsonar-main-request-budget.mjs";

/** Pi 1.4.0's public provider streamSimple extension runs before SDK HTTP generation. */
export const PI_MAIN_REQUEST_BUDGET_SOURCE = String.raw`
import { createAssistantMessageEventStream, streamSimple as sdkStreamSimple } from '@earendil-works/pi-ai/compat';
import { setTimeout as delay } from 'node:timers/promises';

const SUPPORTED = new Set(['anthropic-messages','openai-completions','openai-responses']);
const OM_PROVIDER = '__deepsonar_observational_memory';
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
    if (response.status !== 200) fail('PI_MAIN_BUDGET_ALLOWANCE_DENIED');
    if (typeof value?.policy_required !== 'boolean' || (value.remaining_tokens !== null
      && (!Number.isSafeInteger(value.remaining_tokens) || value.remaining_tokens < 0))) fail('PI_MAIN_BUDGET_ALLOWANCE_INVALID');
    return value;
  }
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
            const allowance = await readMainAllowance(gateway, token, options?.signal);
            const prepared = preparePiMainSdkRequest(requestedModel, options, allowance);
            for await (const event of delegate(prepared.model, context, { ...prepared.options, apiKey: token })) output.push(event);
          } catch (error) {
            const code = /^PI_MAIN_BUDGET_/.test(error?.message ?? '') ? error.message : 'PI_MAIN_BUDGET_REQUEST_FAILED';
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
