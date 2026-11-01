import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function parseBaseline(baselineBytes) {
  const baseline = JSON.parse(baselineBytes);
  if (baseline.schema !== "deepsonar.plan-offline-baseline/v2"
    || !/^[a-f0-9]{40}$/.test(baseline.baseline_commit)
    || !Array.isArray(baseline.cases) || baseline.cases.length === 0
    || !Array.isArray(baseline.modes) || baseline.modes.length === 0
    || baseline.modes.some((mode) => typeof mode !== "string" || mode !== "control_http")
    || new Set(baseline.modes).size !== baseline.modes.length
    || baseline.cases.some((item) => !item || typeof item.id !== "string" || typeof item.category !== "string"
      || !item.expected || typeof item.expected !== "object" || Array.isArray(item.expected))
    || new Set(baseline.cases.map((item) => item.id)).size !== baseline.cases.length
    || !Array.isArray(baseline.unmeasured)) {
    throw new Error("Invalid frozen v2 baseline");
  }
  return baseline;
}

function validObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validTrace(trace) {
  return validObject(trace) && typeof trace.job_id === "string" && trace.job_id.length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value ? bytes : null;
  } catch {
    return null;
  }
}

function validatePositiveTrace(observed, trace) {
  const errors = [];
  const evidence = trace?.evidence;
  if (!validTrace(trace)) errors.push("missing_job_trace");
  for (const [name, value] of [["job_id", trace?.job_id], ["attempt_id", trace?.attempt_id], ["artifact_id", trace?.artifact_id], ["event_id", trace?.event_id]]) {
    if (!isUuid(value)) errors.push(`invalid_${name}`);
  }
  if (trace?.event_count !== undefined && (!Number.isInteger(trace.event_count) || trace.event_count < 1)) errors.push("invalid_event_count");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    errors.push("missing_evidence_trace");
    return { ok: false, errors };
  }
  for (const [name, value] of [["evidence_artifact_id", evidence.artifact_id], ["evidence_source_event_id", evidence.source_event_id], ["evidence_attempt_id", evidence.attempt_id], ["evidence_path_attempt_id", evidence.path_attempt_id]]) {
    if (!isUuid(value)) errors.push(`invalid_${name}`);
  }
  if (evidence.artifact_id !== trace?.artifact_id) errors.push("artifact_identity_mismatch");
  if (evidence.source_event_id !== trace?.event_id) errors.push("event_identity_mismatch");
  if (evidence.attempt_id !== trace?.attempt_id || evidence.path_attempt_id !== trace?.attempt_id) errors.push("evidence_attempt_mismatch");
  if (evidence.source_event_attempt_id !== trace?.attempt_id) errors.push("event_attempt_mismatch");
  if (evidence.source_operation !== "emit_fact") errors.push("unexpected_evidence_source");
  const captured = decodeBase64(evidence.bytes_base64);
  if (!captured) errors.push("evidence_bytes_not_decodable");
  else {
    if (captured.length !== evidence.bytes) errors.push("evidence_byte_count_mismatch");
    if (createHash("sha256").update(captured).digest("hex") !== evidence.sha256) errors.push("evidence_sha_mismatch");
  }
  if (observed?.evidence_bytes !== evidence.bytes || observed?.evidence_sha256 !== evidence.sha256) errors.push("observed_evidence_mismatch");
  if (evidence.manifest_bytes !== evidence.bytes || evidence.manifest_sha256 !== evidence.sha256) errors.push("manifest_entry_mismatch");
  if (typeof evidence.manifest_finalized_at !== "string" || Number.isNaN(Date.parse(evidence.manifest_finalized_at))) errors.push("manifest_not_finalized");
  const manifestRaw = decodeBase64(evidence.manifest_raw_bytes_base64);
  if (!manifestRaw) errors.push("manifest_bytes_not_decodable");
  else {
    if (createHash("sha256").update(manifestRaw).digest("hex") !== evidence.manifest_raw_sha256) errors.push("manifest_raw_sha_mismatch");
    try {
      const manifest = JSON.parse(manifestRaw.toString("utf8"));
      const entry = Array.isArray(manifest.files) ? manifest.files.find((item) => item?.path === evidence.uri) : null;
      if (manifest.job_id !== trace?.job_id) errors.push("manifest_job_mismatch");
      if (manifest.finalized_at !== evidence.manifest_finalized_at) errors.push("manifest_finalization_mismatch");
      if (!entry || entry.bytes !== evidence.bytes || entry.sha256 !== evidence.sha256) errors.push("manifest_file_mismatch");
    } catch {
      errors.push("manifest_json_invalid");
    }
  }
  const pathAttempt = typeof evidence.uri === "string" ? /^attempts\/([^/]+)\//.exec(evidence.uri)?.[1] : null;
  if (pathAttempt !== trace?.attempt_id) errors.push("evidence_uri_attempt_mismatch");
  return { ok: errors.length === 0, errors };
}

function caseKey(mode, id) {
  return `${mode}:${id}`;
}

export function buildReplayReport(baselineBytes, rows, provenance) {
  const baseline = parseBaseline(baselineBytes);
  const expected = new Map(baseline.modes.flatMap((mode) => baseline.cases.map((item) => [caseKey(mode, item.id), { mode, ...item }])));
  const observed = new Map();
  const invalid = [];
  const metadata = [];
  for (const row of rows) {
    if (row?.kind === "meta") {
      metadata.push(row);
      continue;
    }
    const key = caseKey(row?.mode, row?.id);
    if (!expected.has(key) || !row?.observed || typeof row.observed !== "object" || Array.isArray(row.observed) || !validTrace(row.trace)) {
      invalid.push("unknown_or_invalid_case");
      continue;
    }
    if (observed.has(key)) {
      invalid.push(`duplicate:${key}`);
      continue;
    }
    observed.set(key, { observed: row.observed, trace: row.trace });
  }

  const cases = [...expected].map(([key, item]) => {
    const value = observed.get(key);
    const status = !value ? "missing" : isDeepStrictEqual(value.observed, item.expected) ? "match" : "different";
    return {
      mode: item.mode,
      id: item.id,
      category: item.category,
      expected: item.expected,
      observed: value?.observed ?? null,
      status,
      trace: value?.trace ?? null,
    };
  });
  const positiveCase = cases.find((item) => item.id === "positive_output_association");
  const positiveTraceIntegrity = positiveCase
    ? validatePositiveTrace(positiveCase.observed, positiveCase.trace)
    : { ok: false, errors: ["positive_case_missing"] };
  if (!positiveTraceIntegrity.ok) {
    for (const error of positiveTraceIntegrity.errors) invalid.push(`positive_trace:${error}`);
  }
  const matched = cases.filter((item) => item.status === "match").length;
  const faultCases = cases.filter((item) => validTrace(item.trace) && validObject(item.trace.fault_injection));
  const faultChecks = faultCases.map((item) => ({
    mode: item.mode,
    id: item.id,
    expected: item.expected,
    observed: item.observed,
    fault: item.trace.fault_injection,
    status: item.status,
  }));
  const metadataOk = metadata.length === 1
    && metadata[0].schema === "deepsonar.plan-offline-observations/v2"
    && metadata[0].fixture_completed === true
    && metadata[0].real_sql_http === true
    && metadata[0].database_isolated === true
    && metadata[0].case_count === cases.length;
  const categories = Object.fromEntries([...new Set(cases.map((item) => item.category))].map((category) => {
    const group = cases.filter((item) => item.category === category);
    return [category, {
      expected_cases: group.length,
      observed_cases: group.filter((item) => item.status !== "missing").length,
      matching_cases: group.filter((item) => item.status === "match").length,
      differing_cases: group.filter((item) => item.status === "different").length,
      missing_cases: group.filter((item) => item.status === "missing").length,
    }];
  }));
  const execution = cases.filter((item) => item.category === "execution_output");
  const operator = cases.filter((item) => item.category === "operator_gate");
  const control_observations = {
    execution_output_association: {
      expected: execution.length,
      observed: execution.filter((item) => item.observed !== null).length,
      matching: execution.filter((item) => item.status === "match").length,
      retained_attempt_trace: execution.filter((item) => validTrace(item.trace) && item.trace.attempt_id !== null).length,
      retained_evidence_trace: execution.filter((item) => validTrace(item.trace) && validObject(item.trace.evidence)).length,
    },
    operator_authorized_completion: {
      expected: operator.length,
      observed: operator.filter((item) => item.observed !== null).length,
      matching: operator.filter((item) => item.status === "match").length,
      positively_authorized: operator.filter((item) => item.observed?.criteria_all_satisfied === true && item.observed?.completion_status === 200).length,
    },
  };
  const prerequisite_failure = provenance.exit_code !== 0 || !metadataOk || provenance.fixture_completed !== true
    || provenance.real_sql_http !== true || provenance.database_isolated !== true;
  const ordinaryPass = matched === cases.length && invalid.length === 0 && !prerequisite_failure;
  const passed = ordinaryPass && !provenance.fault;
  return {
    schema: "deepsonar.plan-offline-report/v2",
    scope: baseline.scope,
    baseline: {
      commit: baseline.baseline_commit,
      sha256: createHash("sha256").update(baselineBytes).digest("hex"),
    },
    provenance: {
      ...provenance,
      fixture_completed: provenance.fixture_completed === true && metadataOk,
      real_sql_http: provenance.real_sql_http === true && metadataOk,
      database_isolated: provenance.database_isolated === true && metadataOk,
    },
    passed,
    ordinary_pass: ordinaryPass,
    prerequisite_failure,
    denominator: {
      expected: cases.length,
      observed: observed.size,
      matched,
      missing: cases.length - observed.size,
    },
    invalid,
    trace_integrity: {
      positive_output_association: positiveTraceIntegrity,
    },
    metrics: categories,
    control_observations,
    fault_checks: faultChecks,
    cases,
    unmeasured: baseline.unmeasured.map((metric) => ({ metric, value: null, reason: "not_measured_by_control_replay" })),
    interpretation: "Synthetic current-v2 SQL/HTTP control regression only; retained Attempt/evidence traces are engineering evidence, not model-quality or production evidence.",
  };
}
