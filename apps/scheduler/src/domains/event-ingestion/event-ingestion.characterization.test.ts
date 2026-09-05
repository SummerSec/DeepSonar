import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coreSource = readFileSync(new URL("../../core.ts", import.meta.url), "utf8");
const sideEffectSource = readFileSync(new URL("./side-effects.ts", import.meta.url), "utf8");
const applicationSource = readFileSync(new URL("./application.ts", import.meta.url), "utf8");

test("event-ingestion owns semantic side effects behind explicit ports", () => {
  const facade = coreSource.match(/export async function applySideEffects\([\s\S]*?\n}\n/)?.[0];
  assert.ok(facade, "core compatibility facade must remain available");
  assert.match(facade, /eventIngestionSideEffectApplication\.applySideEffects/);
  assert.ok(facade.length < 700, "core must not retain the semantic side-effect implementation");

  assert.doesNotMatch(coreSource, /SEMANTIC_TOOL_BY_EVENT|semanticJobContract|assertTerminalEventHistory/);
  assert.match(sideEffectSource, /assertTerminalEventHistory/);
  assert.match(
    sideEffectSource,
    /created_at >= COALESCE\([\s\S]*job_attempts[\s\S]*status = 'active'/,
    "terminal mutex must be scoped to the current Attempt, not the whole Job ledger",
  );
  assert.match(
    sideEffectSource,
    /jobStatusAtLock \?\? job\.status/,
    "running guard must use ingest lock-time status so same-turn follow-ups do not roll back a close",
  );
  assert.match(applicationSource, /orderSemanticIngestBundle/);
  assert.match(applicationSource, /finalizedInThisIngest && envelope\.type === "done"/);
  assert.match(applicationSource, /shouldSkipTerminalAfterAcceptedHuman/);
  assert.match(applicationSource, /acceptedHumanInThisIngest/);
  assert.match(sideEffectSource, /createEventIngestionSideEffectApplication/);
  assert.match(sideEffectSource, /findingVerification/);
  assert.match(sideEffectSource, /resolveAgentSnapshotForJob/);
  assert.match(sideEffectSource, /assertFrozenRuntimeImageLocal/);
  assert.match(sideEffectSource, /blockHubOnMissingLocalImage/);
  assert.match(sideEffectSource, /isHubRuntimeImageResolutionError/);
  assert.match(sideEffectSource, /phase === "preflight" && key/);
  assert.match(sideEffectSource, /invalidRuntimeImage\(`intents\.\$\{index\}\.runtime_image_key`/);
  assert.match(
    sideEffectSource,
    /UPDATE canvas_nodes SET status = 'waiting_human'[\s\S]*node_type IN \('job', 'intent', 'report'\)/,
  );
  assert.match(sideEffectSource, /finalizeJob/);
  assert.doesNotMatch(sideEffectSource, /from ["'](?:\.\.\/)+core\.js["']/);
  assert.doesNotMatch(sideEffectSource, /import\(/);
});
