import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The exporter and process counters are real; only scrape-time database gauges are stubbed.
let skillSourceRows: Array<{ name: string; age: number | null }> = [];
mock.module(new URL("./db.js", import.meta.url), {
  namedExports: { sql: async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM skill_sources")) {
      assert.ok(query.includes("now() - synced_at"));
      assert.ok(!query.includes("created_at"), "creation time cannot masquerade as a successful sync");
      return skillSourceRows;
    }
    return [{ n: 0, paused: false }];
  } },
});
const { inc, observe, renderMetrics } = await import("./metrics.js");

test("Prometheus exports gateway database conflict counts with workload and SQLSTATE labels", async () => {
  const name = "deepsonar_gateway_db_conflict_retries_total";
  inc(name, { workload: "main", code: "40P01" });
  inc(name, { workload: "main", code: "40P01" }, 2);
  inc(name, { workload: "observational_memory", code: "40001" }, 2);
  inc(name, { workload: "observational_memory", code: "55P03" });
  inc("deepsonar_gateway_db_conflict_exhausted_total", { workload: "observational_memory", code: "55P03" });

  const output = await renderMetrics();
  assert.match(output, /^# HELP deepsonar_gateway_db_conflict_retries_total .+$/mu);
  assert.match(output, /^# TYPE deepsonar_gateway_db_conflict_retries_total counter$/mu);
  assert.match(output, /^deepsonar_gateway_db_conflict_retries_total\{workload="main",code="40P01"\} 3$/mu);
  assert.match(output, /^deepsonar_gateway_db_conflict_retries_total\{workload="observational_memory",code="40001"\} 2$/mu);
  assert.match(output, /^deepsonar_gateway_db_conflict_retries_total\{workload="observational_memory",code="55P03"\} 1$/mu);
  assert.equal(output.split("\n").filter((line) => line.startsWith(`${name}{`)).length, 3);
  assert.match(output, /^# HELP deepsonar_gateway_db_conflict_exhausted_total .+$/mu);
  assert.match(output, /^# TYPE deepsonar_gateway_db_conflict_exhausted_total counter$/mu);
  assert.match(output, /^deepsonar_gateway_db_conflict_exhausted_total\{workload="observational_memory",code="55P03"\} 1$/mu);
});

test("never verified Skill age is valid Prometheus +Inf, not creation age or fake zero", async () => {
  skillSourceRows = [{ name: 'never\\verified\n"source"', age: null }, { name: "approved", age: 90 }];
  try {
    const output = await renderMetrics();
    const samples = output.split("\n").filter(line => line.startsWith("deepsonar_skill_source_age_seconds{"));
    assert.deepEqual(samples, [
      'deepsonar_skill_source_age_seconds{source="never\\\\verified\\n\\"source\\""} +Inf',
      'deepsonar_skill_source_age_seconds{source="approved"} 90',
    ]);
    assert.ok(!output.includes(" Infinity"));
  } finally { skillSourceRows = []; }
});

test("Prometheus exports context database conflict counts with operation and SQLSTATE labels", async () => {
  const name = "deepsonar_database_conflict_retries_total";
  inc(name, { operation: "context", code: "40P01" });
  inc(name, { operation: "context", code: "40P01" }, 2);
  inc(name, { operation: "context", code: "40001" }, 2);
  inc(name, { operation: "context", code: "55P03" });
  inc("deepsonar_database_conflict_exhausted_total", { operation: "context", code: "40001" });

  const output = await renderMetrics();
  assert.match(output, /^# HELP deepsonar_database_conflict_retries_total .+$/mu);
  assert.match(output, /^# TYPE deepsonar_database_conflict_retries_total counter$/mu);
  assert.match(output, /^deepsonar_database_conflict_retries_total\{operation="context",code="40P01"\} 3$/mu);
  assert.match(output, /^deepsonar_database_conflict_retries_total\{operation="context",code="40001"\} 2$/mu);
  assert.match(output, /^deepsonar_database_conflict_retries_total\{operation="context",code="55P03"\} 1$/mu);
  assert.match(output, /^# HELP deepsonar_database_conflict_exhausted_total .+$/mu);
  assert.match(output, /^# TYPE deepsonar_database_conflict_exhausted_total counter$/mu);
  assert.match(output, /^deepsonar_database_conflict_exhausted_total\{operation="context",code="40001"\} 1$/mu);
  assert.equal(output.split("\n").filter((line) => line.startsWith(`${name}{`)).length, 3);
});

test("Prometheus exports list query latency histogram with cumulative buckets (#1136)", async () => {
  observe("deepsonar_api_list_query_seconds", 0.03, { endpoint: "jobs", paginated: "no" });
  observe("deepsonar_api_list_query_seconds", 12, { endpoint: "jobs", paginated: "no" });
  observe("deepsonar_api_list_query_seconds", -1, { endpoint: "jobs", paginated: "no" });
  observe("deepsonar_api_list_query_seconds", 0.4, { endpoint: "jobs", paginated: "yes" });

  const output = await renderMetrics();
  assert.match(output, /^# TYPE deepsonar_api_list_query_seconds histogram$/mu);
  // 累积桶：12s 只落在 30 与 +Inf；0.03 落在 0.05 及以上的所有桶
  assert.match(output, /^deepsonar_api_list_query_seconds_bucket\{endpoint="jobs",paginated="no",le="0.05"\} 1$/mu);
  assert.match(output, /^deepsonar_api_list_query_seconds_bucket\{endpoint="jobs",paginated="no",le="5"\} 1$/mu);
  assert.match(output, /^deepsonar_api_list_query_seconds_bucket\{endpoint="jobs",paginated="no",le="\+Inf"\} 2$/mu);
  assert.match(output, /^deepsonar_api_list_query_seconds_count\{endpoint="jobs",paginated="no"\} 2$/mu);
  assert.match(output, /^deepsonar_api_list_query_seconds_sum\{endpoint="jobs",paginated="no"\} 12\.03$/mu);
  // 分页维度独立成组
  assert.match(output, /^deepsonar_api_list_query_seconds_count\{endpoint="jobs",paginated="yes"\} 1$/mu);
});
