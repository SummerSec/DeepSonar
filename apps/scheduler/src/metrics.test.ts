import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The exporter and process counters are real; only scrape-time database gauges are stubbed.
mock.module(new URL("./db.js", import.meta.url), {
  namedExports: { sql: async () => [{ n: 0, paused: false }] },
});
const { inc, renderMetrics } = await import("./metrics.js");

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
