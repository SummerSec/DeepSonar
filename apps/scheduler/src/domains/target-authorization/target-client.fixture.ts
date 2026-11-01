import {
  REFERENCE_TARGET_ACTIONS,
  type TargetAuthorizationSnapshot,
} from "./contract.js";

// Test-only transport. Never exported by the production domain entry point.
export const TARGET_FIXTURE_CREDENTIAL = "reference-target-fixture-only" as const;

const ACTION_PATHS = {
  "reference-http.save": "/save",
  "reference-http.publish": "/publish",
  "reference-http.trigger": "/trigger",
} as const;

export class TargetExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TargetExecutionError";
    this.code = code;
  }
}

export interface TargetActionResult {
  action: keyof typeof ACTION_PATHS;
  status: number;
  body: string;
}

/**
 * Drive an isolated HTTP fixture, using a literal loopback endpoint and a
 * public fake credential. Authority secrets and host target configuration are
 * deliberately absent. This helper is imported only by tests.
 */
export async function executeReferenceTargetFixture(
  snapshot: TargetAuthorizationSnapshot,
  input: {
    jobId: string;
    fixtureBaseUrl: string;
    fixtureCredential: typeof TARGET_FIXTURE_CREDENTIAL;
    timeoutMs?: number;
  },
): Promise<TargetActionResult[]> {
  const endpoint = new URL(input.fixtureBaseUrl);
  if (endpoint.protocol !== "http:"
    || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || !endpoint.port || endpoint.pathname !== "/"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || input.fixtureCredential !== TARGET_FIXTURE_CREDENTIAL) {
    throw new TargetExecutionError(
      "target_fixture_invalid",
      "target fixture requires an explicit loopback endpoint and fake credential",
    );
  }
  if (JSON.stringify(snapshot.requested_actions) !== JSON.stringify(REFERENCE_TARGET_ACTIONS)) {
    throw new TargetExecutionError(
      "target_execution_snapshot_invalid",
      "target fixture requires the exact reference action chain",
    );
  }
  const timeoutMs = input.timeoutMs ?? 1000;
  const maxBodyBytes = 4096;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
    throw new TargetExecutionError("target_fixture_invalid", "target fixture timeout is invalid");
  }

  const results: TargetActionResult[] = [];
  for (const action of snapshot.requested_actions) {
    const path = ACTION_PATHS[action as keyof typeof ACTION_PATHS];
    if (!path) {
      throw new TargetExecutionError("target_execution_action_invalid", "frozen target action is not admitted");
    }
    const body = JSON.stringify({
      protocol: snapshot.protocol,
      action,
      job_id: input.jobId,
      project_id: snapshot.project_id,
      target_id: snapshot.target_id,
      principal_id: snapshot.principal_id,
      tenant: snapshot.tenant,
      role: snapshot.role,
      resource: snapshot.resource,
      content_sha256: snapshot.content_sha256,
      task_contract_sha256: snapshot.task_contract_sha256,
      revision: snapshot.revision,
      authority_revision: snapshot.authority_revision,
    });
    if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
      throw new TargetExecutionError("target_execution_request_too_large", "reference target request exceeds the platform limit");
    }
    const controller = new AbortController();
    const timeoutMarker = Symbol("target-execution-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutMarker);
      }, timeoutMs);
    });
    let response: Response | undefined;
    try {
      response = await Promise.race([
        fetch(new URL(path, endpoint), {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${input.fixtureCredential}`,
          },
          body,
          redirect: "error",
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (response.status >= 300 && response.status < 400) {
        throw new TargetExecutionError("target_execution_redirect_rejected", "reference target redirect rejected");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new TargetExecutionError("target_execution_failed", `reference target returned status ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        throw new TargetExecutionError("target_execution_response_too_large", "reference target response exceeds the platform limit");
      }
      const responseBody = response.body
        ? await Promise.race([
          readBoundedTargetBody(response, maxBodyBytes),
          timeoutPromise,
        ])
        : "";
      results.push({ action: action as keyof typeof ACTION_PATHS, status: response.status, body: responseBody });
    } catch (error) {
      if (error instanceof TargetExecutionError) throw error;
      if (error === timeoutMarker || controller.signal.aborted) {
        throw new TargetExecutionError("target_execution_timeout", "reference target request timed out");
      }
      if (isExplicitRedirectError(error)) {
        throw new TargetExecutionError("target_execution_redirect_rejected", "reference target redirect rejected");
      }
      throw new TargetExecutionError("target_execution_unavailable", "reference target transport is unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return results;
}

async function readBoundedTargetBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, total).toString("utf8");
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TargetExecutionError("target_execution_response_too_large", "reference target response exceeds the platform limit");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
}

function isExplicitRedirectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === "UND_ERR_REDIRECT" || candidate.cause?.code === "UND_ERR_REDIRECT";
}
