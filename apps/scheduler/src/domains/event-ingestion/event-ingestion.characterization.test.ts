import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coreSource = readFileSync(new URL("../../core.ts", import.meta.url), "utf8");
const sideEffectSource = readFileSync(new URL("./side-effects.ts", import.meta.url), "utf8");

test("event-ingestion owns semantic side effects behind explicit ports", () => {
  const facade = coreSource.match(/export async function applySideEffects\([\s\S]*?\n}\n/)?.[0];
  assert.ok(facade, "core compatibility facade must remain available");
  assert.match(facade, /eventIngestionSideEffectApplication\.applySideEffects/);
  assert.ok(facade.length < 700, "core must not retain the semantic side-effect implementation");

  assert.doesNotMatch(coreSource, /SEMANTIC_TOOL_BY_EVENT|semanticJobContract|assertTerminalEventHistory/);
  assert.match(sideEffectSource, /createEventIngestionSideEffectApplication/);
  assert.match(sideEffectSource, /findingVerification/);
  assert.match(sideEffectSource, /resolveAgentSnapshotForJob/);
  assert.match(sideEffectSource, /assertFrozenRuntimeImageLocal/);
  assert.match(sideEffectSource, /blockHubOnMissingLocalImage/);
  assert.match(sideEffectSource, /finalizeJob/);
  assert.doesNotMatch(sideEffectSource, /from ["'](?:\.\.\/)+core\.js["']/);
  assert.doesNotMatch(sideEffectSource, /import\(/);
});
