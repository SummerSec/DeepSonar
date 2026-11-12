/** Embedded in both generated Pi and DSH policies; never serializes error prose. */
export const PI_REQUEST_ERROR_DIAGNOSTIC_SOURCE = String.raw`
const hostFailures = new WeakMap();
function fail(code) {
  const error = new Error(code);
  hostFailures.set(error, code);
  throw error;
}
const diagnosticNames = new Set(['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError',
  'APIError','APIConnectionError','APIConnectionTimeoutError','APIUserAbortError','AuthenticationError',
  'PermissionDeniedError','BadRequestError','NotFoundError','ConflictError','UnprocessableEntityError',
  'RateLimitError','InternalServerError']);
const transientCodes = new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ENETUNREACH','EHOSTUNREACH',
  'EAI_AGAIN','ETIMEDOUT','EPIPE','ERR_NETWORK','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const cancellationCodes = new Set(['ABORT_ERR','ERR_CANCELED']);
const transientStatuses = new Set([408,429,500,502,503,504]);
// Read only data properties. Untrusted accessors/proxies must not break error reporting.
function diagnosticField(value, key) {
  try {
    for (let depth = 0; value && (typeof value === 'object' || typeof value === 'function') && depth < 4; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      value = Object.getPrototypeOf(value);
    }
  } catch {}
}
function permanentRequestDiagnostic(detail, signal) {
  if (signal?.aborted) return true;
  for (let current = detail; current; current = current.cause) {
    if (['AbortError','APIUserAbortError','AuthenticationError','PermissionDeniedError'].includes(current.name)
      || cancellationCodes.has(current.code)
      || current.status !== undefined && !transientStatuses.has(current.status)) return true;
  }
  return false;
}
function requestDiagnostic(error, stage, signal) {
  const seen = new Set();
  let incomplete = false;
  function project(value, depth) {
    if (!value || typeof value !== 'object') return undefined;
    if (depth >= 4 || seen.has(value)) { incomplete = true; return undefined; }
    seen.add(value);
    const result = {};
    const name = diagnosticField(value, 'name');
    const code = diagnosticField(value, 'code');
    if (diagnosticNames.has(name)) result.name = name;
    if (transientCodes.has(code) || cancellationCodes.has(code)) result.code = code;
    const status = diagnosticField(value, 'status');
    const statusCode = diagnosticField(value, 'statusCode');
    const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
    const statuses = [status, statusCode].filter(validStatus);
    const selectedStatus = statuses.find(value => !transientStatuses.has(value)) ?? statuses[0];
    if (selectedStatus !== undefined) result.status = selectedStatus;
    const cause = project(diagnosticField(value, 'cause'), depth + 1);
    if (cause && Object.keys(cause).length) result.cause = cause;
    return result;
  }
  const detail = project(error, 0) ?? {};
  let transient = false;
  for (let current = detail; current; current = current.cause) {
    if (transientCodes.has(current.code) || ['TimeoutError','APIConnectionError','APIConnectionTimeoutError',
      'RateLimitError','InternalServerError'].includes(current.name)
      || transientStatuses.has(current.status)) transient = true;
  }
  return { version:1, stage, category:!incomplete && !permanentRequestDiagnostic(detail, signal) && transient
    ? 'transient_retryable' : 'permanent_failure', ...detail };
}
function requestFailureMessage(error, stage, signal) {
  if (error === completionAlreadyAccepted) return 'COMPLETION_ALREADY_ACCEPTED';
  const hostCode = error && typeof error === 'object' ? hostFailures.get(error) : undefined;
  return hostCode ?? 'PI_MAIN_BUDGET_REQUEST_FAILED; diagnostic=' + JSON.stringify(requestDiagnostic(error, stage, signal));
}
function failRequest(error, stage, signal) {
  // Host identities and already projected diagnostics survive shared-reader catches.
  if (error === completionAlreadyAccepted || error && typeof error === 'object' && hostFailures.has(error)) throw error;
  fail(requestFailureMessage(error, stage, signal));
}
`;
