import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_WINDOW_EXCEEDED_REASON,
  TaskContractPromptBudgetExceededError,
  compactPromptForContextWindowRetry,
  countConsumedContextWindowRetries,
  estimatePromptTokens,
  formatContextWindowExceededMessage,
  isContextWindowExceededMessage,
  planAutomaticContextWindowRetry,
  planSameSessionContextCompactionResume,
  readContextWindowCompactRetryMarker,
  buildContextWindowCompactRetryMarker,
} from "./context-window-exceeded.js";

test("context window messages match Prompt is too long and common variants", () => {
  for (const message of [
    "Prompt is too long",
    "agent 运行失败: Prompt is too long",
    "Error: prompt is too long for this model",
    "context_length_exceeded",
    "This model's maximum context length is 128000 tokens",
    "request exceeds the context window",
  ]) {
    assert.equal(isContextWindowExceededMessage(message), true, message);
  }
  for (const message of [
    "Anthropic stream ended without a stop reason",
    "HTTP 401 unauthorized",
    "network error: ECONNRESET",
    "PI_EMPTY_MODEL_RESPONSE",
  ]) {
    assert.equal(isContextWindowExceededMessage(message), false, message);
  }
});

test("context window retry budget is one and ignores attempt_no", () => {
  assert.deepEqual(planAutomaticContextWindowRetry(0), { retry: true, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticContextWindowRetry(1), { retry: false, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticContextWindowRetry(99), { retry: false, nextRetryCount: 99 });
  assert.equal(
    countConsumedContextWindowRetries([
      { status: "failed", outcome_json: { reason: CONTEXT_WINDOW_EXCEEDED_REASON } },
      { status: "failed", outcome_json: { reason: "pi_stream_truncated" } },
      { status: "active", outcome_json: { reason: CONTEXT_WINDOW_EXCEEDED_REASON } },
    ]),
    1,
  );
});

test("compactPromptForContextWindowRetry keeps head/tail under budget", () => {
  const huge = "HEAD".repeat(50_000) + "MIDDLE_EVIDENCE".repeat(80_000) + "TAIL".repeat(20_000);
  const result = compactPromptForContextWindowRetry(huge, 8_000);
  assert.equal(result.compacted, true);
  assert.ok(result.estimatedTokensAfter < result.estimatedTokensBefore);
  assert.ok(result.estimatedTokensAfter <= Math.floor(result.budgetTokens * 0.55) + 64);
  assert.match(result.prompt, /deepsonar:context_window_compact_retry/);
  assert.ok(result.prompt.startsWith("HEAD"));
  assert.ok(result.prompt.includes("TAIL"));
});

test("compactPromptForContextWindowRetry is a no-op when already under budget", () => {
  const small = "short prompt";
  const result = compactPromptForContextWindowRetry(small, 128_000);
  assert.equal(result.compacted, false);
  assert.equal(result.prompt, small);
  assert.equal(result.estimatedTokensBefore, estimatePromptTokens(small));
});

test("actionable failure message includes tokens and exhaustion hint", () => {
  const message = formatContextWindowExceededMessage({
    errorMessage: "agent 运行失败: Prompt is too long",
    contextWindowTokens: 128_000,
    estimatedPromptTokens: 200_000,
    compactRetryExhausted: true,
  });
  assert.match(message, /context_window_exceeded/);
  assert.match(message, /estimated_tokens≈200000/);
  assert.match(message, /context_window_tokens=128000/);
  assert.match(message, /compaction retry exhausted/);
});

test("compact retry marker round-trips on payload", () => {
  const marker = buildContextWindowCompactRetryMarker("Prompt is too long");
  const payload = { context_window_compact_retry: marker };
  assert.deepEqual(readContextWindowCompactRetryMarker(payload), marker);
  assert.equal(readContextWindowCompactRetryMarker({}), null);
});

test("same-session compaction resume hook is deferred stub", () => {
  assert.deepEqual(
    planSameSessionContextCompactionResume({ hasSessionId: true, adapterSupportsCompaction: true }),
    { resume: false, cause: "compaction_hook_deferred" },
  );
});


test("compact retry preserves complete frozen rules for every execution role within budget", () => {
  const frozenRules = "\n\n任务契约：" + JSON.stringify({
    objective: "验证授权范围内的结论",
    outcome: { mode: "evidence_required", rule_version: 1, acceptance: ["不得把未知项视为完成"], digest: "sha256:frozen" },
  });
  for (const role of ["hub_reason", "worker", "verify", "report"]) {
    const body = `${role} instructions\n` + "evidence ".repeat(80_000) + "tool guide".repeat(2_000);
    const result = compactPromptForContextWindowRetry(body, 8_000, frozenRules);
    assert.equal(result.compacted, true, role);
    assert.ok(result.prompt.endsWith(frozenRules), role);
    assert.equal(result.prompt.split(frozenRules).length, 2, "frozen rules appear exactly once");
    assert.ok(result.estimatedTokensAfter <= Math.floor(8_000 * 0.55));
    assert.equal(result.estimatedTokensBefore, estimatePromptTokens(body + frozenRules));
  }
});

test("protected rules remain in a short retry prompt and empty rules preserve generic behavior", () => {
  const body = "short task";
  const rules = "\nfrozen acceptance rules";
  const result = compactPromptForContextWindowRetry(body, 8_000, rules);
  assert.equal(result.compacted, false);
  assert.equal(result.prompt, body + rules);
  const large = "ordinary task evidence ".repeat(10_000);
  assert.deepEqual(compactPromptForContextWindowRetry(large, 8_000, ""), compactPromptForContextWindowRetry(large, 8_000));
});

test("protected-rule overflow fails explicitly without exposing rule content or retry classification", () => {
  const protectedRules = "sensitive-user-task-content".repeat(1_000);
  assert.throws(() => compactPromptForContextWindowRetry("history".repeat(10_000), 1_024, protectedRules), (error: unknown) => {
    assert.ok(error instanceof TaskContractPromptBudgetExceededError);
    assert.equal(error.code, "task_contract_prompt_budget_exceeded");
    assert.ok(error.requiredTokens > error.targetTokens);
    assert.equal(error.message.includes("sensitive-user-task-content"), false);
    assert.equal(isContextWindowExceededMessage(error.message), false);
    return true;
  });
});

test("protected-rule admission boundary budgets both marker and retained context", () => {
  const body = "evidence".repeat(10_000);
  // Locate the exact boundary without relying on marker formatting constants.
  let largestAccepted = 0;
  for (let low = 0, high = 4_096; low <= high;) {
    const size = Math.floor((low + high) / 2);
    try {
      const result = compactPromptForContextWindowRetry(body, 1_024, "r".repeat(size));
      assert.ok(result.estimatedTokensAfter <= 1_024);
      largestAccepted = size;
      low = size + 1;
    } catch (error) {
      assert.ok(error instanceof TaskContractPromptBudgetExceededError);
      high = size - 1;
    }
  }
  assert.ok(largestAccepted > 0 && largestAccepted < 4_096);
  assert.ok(compactPromptForContextWindowRetry(body, 1_024, "r".repeat(largestAccepted)).prompt.endsWith("r".repeat(largestAccepted)));
  assert.throws(() => compactPromptForContextWindowRetry(body, 1_024, "r".repeat(largestAccepted + 1)), TaskContractPromptBudgetExceededError);
});
