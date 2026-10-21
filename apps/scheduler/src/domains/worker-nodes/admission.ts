import { hashWorkerToken, workerTokensEqual, WORKER_PROTOCOL_VERSION } from "./model.js";

export { WORKER_PROTOCOL_VERSION } from "./model.js";
export interface WorkerAdmission {
  protocolVersion?: number;
  platformVersion?: string;
  deploymentGeneration?: string;
}
export interface WorkerUpgradeState {
  generation: string;
  runtime_role: string;
  target_version: string;
  phase: "preparing" | "active";
  worker_generation_token_hash: string;
}

export function workerAdmissionMatches(state: WorkerUpgradeState | undefined, input: WorkerAdmission, serverVersion: string): boolean {
  return Boolean(state && state.phase === "active" && serverVersion &&
    (!state.target_version || state.target_version === serverVersion) &&
    input.protocolVersion === WORKER_PROTOCOL_VERSION && input.platformVersion === serverVersion &&
    typeof input.deploymentGeneration === "string" && input.deploymentGeneration === state.generation);
}

export function workerGenerationTokenMatches(state: WorkerUpgradeState, token: string | undefined): boolean {
  if (!state.generation) return true;
  return Boolean(token && /^[0-9a-f]{64}$/.test(state.worker_generation_token_hash) &&
    workerTokensEqual(hashWorkerToken(token), state.worker_generation_token_hash));
}
