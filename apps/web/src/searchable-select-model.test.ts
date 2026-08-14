import assert from "node:assert/strict";
import test from "node:test";
import { filterSelectOptions, readMultiSearchParam, toggleMultiValue, writeMultiSearchParam } from "./searchable-select-model";

const options = [
  { value: "critical", label: "严重", keywords: ["p0"] },
  { value: "medium", label: "中危" },
  { value: "low", label: "低危" },
];

test("searchable select matches labels values and keywords", () => {
  assert.deepEqual(filterSelectOptions(options, "中").map((option) => option.value), ["medium"]);
  assert.deepEqual(filterSelectOptions(options, "LOW").map((option) => option.value), ["low"]);
  assert.deepEqual(filterSelectOptions(options, "p0").map((option) => option.value), ["critical"]);
});

test("multi-select toggle preserves option order and removes selected values", () => {
  assert.deepEqual(toggleMultiValue(["high"], "medium"), ["high", "medium"]);
  assert.deepEqual(toggleMultiValue(["high", "medium"], "high"), ["medium"]);
});

test("multi-select URL params accept repeated and comma-separated values", () => {
  const params = new URLSearchParams("status=running,failed&status=timeout");
  assert.deepEqual(readMultiSearchParam(params, "status"), ["running", "failed", "timeout"]);
  writeMultiSearchParam(params, "status", ["failed", "failed", "running"]);
  assert.equal(params.get("status"), "failed,running");
  assert.deepEqual(params.getAll("status"), ["failed,running"]);
});
