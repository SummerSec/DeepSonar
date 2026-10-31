import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("scheduler kernel does not own DSH wire schema", () => {
  assert.equal(existsSync(join(here, "dsh-pi-ai-settings.ts")), false);
  const kernel = [
    "core.ts",
    "dispatcher.ts",
    "domains/event-ingestion/side-effects.ts",
    "domains/job-lifecycle/application.ts",
    "domains/hub-orchestration/application.ts",
  ];
  for (const relative of kernel) {
    const source = readFileSync(join(here, relative), "utf8");
    assert.doesNotMatch(source, /dsh-pi-ai-settings|llm-pi-ai|DSH_PI_AI_PROTOCOLS|PROFILE_KEYS/);
  }
  const executor = readFileSync(join(here, "executor-real.ts"), "utf8");
  assert.match(executor, /runtimeAdapter\.projectRuntime/);
  assert.doesNotMatch(executor, /buildDshPiAiRuntimeProjection|dsh-pi-ai-settings/);
});
