import { PI_MAIN_REQUEST_BUDGET_SOURCE } from "./pi-main-request-budget.js";

export const DSH_REQUEST_BUDGET_PLUGIN = "/opt/deepsonar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/deepsonar-index.js";
export const DSH_REQUEST_BUDGET_VENDOR_SHA256 = "99b5c20830a52f69641df8a18a39206079b0c725201958cce2c4a934f1d4f7cd";

// Share the actual SDK input policy with Pi. The extension registration is Pi-only;
// DSH calls these same functions immediately before its official SDK invocation.
const shared = PI_MAIN_REQUEST_BUDGET_SOURCE
  .replace(/^import .* from '@earendil-works\/pi-ai\/compat';\n/mu, "")
  .split("export function createPiMainRequestBudgetExtension")[0];
export const DSH_REQUEST_BUDGET_SOURCE = shared + String.raw`
let launchIdentity;
export function frozenDshIdentity(env = process.env) {
  if (launchIdentity) return launchIdentity;
  let identity;
  try { identity = JSON.parse(env.DEEPSONAR_DSH_FROZEN_IDENTITY); } catch { fail('DSH_BUDGET_IDENTITY_MISSING'); }
  if (!identity || !['provider','id','api','baseUrl'].every(key => typeof identity[key] === 'string' && identity[key])) fail('DSH_BUDGET_IDENTITY_INVALID');
  return launchIdentity = Object.freeze({ ...identity, baseUrl: endpoint(identity.baseUrl), gatewayRoot: endpoint(env.DEEPSONAR_REQUEST_POLICY_UPSTREAM), token: env.DEEPSONAR_GATEWAY_TOKEN });
}
export function assertDshSdkIdentity(model, options, identity) {
  if (!identity || model.provider !== identity.provider || model.id !== identity.id || model.api !== identity.api
    || endpoint(model.baseUrl) !== endpoint(identity.baseUrl)) fail('DSH_BUDGET_MODEL_CHANGED');
  if (!identity.token || options?.apiKey !== identity.token) fail('DSH_BUDGET_AUTH_MISMATCH');
}
export async function prepareSdkCall({ model, options, context, signal, frozenIdentity, piAiRoot }) {
  const identity = frozenIdentity;
  assertDshSdkIdentity(model, options, identity);
  const allowance = await readMainAllowance(identity.gatewayRoot, identity.token, signal);
  const prepared = preparePiMainSdkRequest(model, options, allowance);
  if (allowance.policy_required && model.api === 'anthropic-messages' && model.reasoning && options?.reasoning
    && model.compat?.forceAdaptiveThinking !== true && model.compat?.supportsMidConvoEffort !== true) {
    const clamp = await loadPiContextClamp(piAiRoot);
    assertPiAnthropicThinkingBudget(prepared.model, prepared.options, clamp(prepared.model, context, prepared.options.maxTokens));
  }
  return prepared;
}
`;
