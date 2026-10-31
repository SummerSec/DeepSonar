# Current Plan v2 replay verification

Worktree: `D:/ghproject/DeepSonar-work-775`.
Source contract: `4844cf74d46b6da76ef9e6702cac062a22a15bbe`.
Release context: v0.6.3 is the parent target; formally published v0.6.2 is untouched.

The scoped worker reran its final normal replay, complete negative matrix,
report tests, Scheduler typecheck, Web tests and applicable repository checks.
These are local worktree observations; the parent must independently verify
the integrated tree. Remote CI was not run.

## Changed paths

- `agent-harness/plan-replay/run.mjs`: invokes `process.execPath` and installed
  local tsx against the dedicated current-v2 SQL fixture; removes stale reports
  before prerequisite checks and retains the CI report path.
- `agent-harness/plan-replay/report.mjs`: compares the frozen v2 outcomes,
  preserves per-case missing/different results and traces, rejects incomplete
  fixture runs, and validates captured Attempt/evidence/manifest identity and
  bytes before a positive gate can pass.
- `agent-harness/plan-replay/negative.mjs`: verifies seven actual faulted
  fixture paths, their specific bad responses/state, and nonzero gate exits;
  prerequisite failures cannot satisfy a negative case.
- `agent-harness/plan-replay/report.test.mjs`: eight parser/launcher tests,
  including trace loss with otherwise matching observations and stale-green
  artifact removal. These synthetic unit checks do not stand in for SQL replay.
- `agent-harness/plan-replay/baseline-v2.json`: independent 17-case v2 oracle.
- `agent-harness/plan-replay/BASELINE-V2-PROPOSAL.md`: source-derived expected
  outcomes and the test-only fault matrix, defined before replay inspection.
- `agent-harness/plan-replay/README.md`: current local/CI entry points, evidence
  scope and limits.
- `apps/scheduler/src/plan-replay-v2.integration.test.ts`: production HTTP,
  ingestion and admitted Intent chain instrumentation with real isolated SQL,
  Attempt identities and retained evidence bytes.
- `apps/web/src/plan-gap-report.test.ts`: current v2, historical v1 and native
  report rendering behavior.
- `agent-harness/plan-replay/LOCAL-VERIFICATION.md`: this reviewed handoff.

`baseline.json` remains byte-identical historical v1 input. There is no v1
execution fallback in the current launcher/report gate.

## Replay result and immutable expectations

The coordinator recorded the v2 oracle digest before reading actual replay
artifacts. It stayed unchanged through the final implementation and reruns:

```text
historical baseline.json: 04299a2243cabc667eaf4e6fc2552d7ab94341d2f786213ef024681bb4f1b0b1
current baseline-v2.json: a273a930b1cdfa16444787c639e7a8c11b99ad2995cd56afce9b3295a128bb6b
```

The 17 observed outcomes cover two-task dependent execution, exact output
association, idempotent route replay, source scope, forbidden system role,
stale route and Canvas input, historical v1 refusal/readback, completion without
operator bindings, positive operator bindings, unknown effects, missing output,
failed/timeout/cancelled/orphan terminal children, no progress and human stop.
The unbound-criterion case completes its child/Attempt and output route first;
it therefore tests the additional operator gate rather than an unfinished Job.

Final normal artifact: `artifacts/plan-replay/report.json`:

- `schema=deepsonar.plan-offline-report/v2`, `passed=true`.
- Denominator: expected 17, observed 17, matched 17, missing 0.
- `invalid=[]`; positive output trace integrity `ok=true`, errors empty.
- Captured original evidence and manifest bytes, recomputed SHA, current
  Attempt path, Artifact and source event identities remain in the JSON trace.
- Dependency Attempt and Artifact references are compared to the actual
  predecessor identities. Output associations are read from both the Artifact
  and its source event, not inferred from `done` or child counts.

Final negative artifact: `artifacts/plan-replay/negative-regression.json`:
all seven cases completed their fixture with exit 0, retained all 17 outcomes,
and made the replay gate exit 1. Each report has 16 matches, one actual
difference, zero missing cases and no prerequisite failure.

| Test-only fault | Actual bad observation retained | Gate exit |
| --- | --- | --- |
| `unproven_completion_accepted` | Current output route completed, criterion unbound, Hub completion HTTP 200 | 1 |
| `scope_cross_project_accepted` | Handler rewrites the out-of-scope input; actual HTTP 200, one child and Plan event | 1 |
| `stale_route_accepted` | Handler rewrites stale CAS input; actual HTTP 200, two Plan events with the existing child | 1 |
| `unknown_effect_replayed` | Test SQL clears ledger `unknown` to `settled`; actual completion HTTP 200 with no stop | 1 |
| `evidence_bytes_fabricated` | Actual retained file is changed to 22 bytes while finalized manifest declares 43; dependent not released | 1 |
| `system_role_accepted` | Handler rewrites forbidden role input; actual HTTP 200, one child and Plan event | 1 |
| `stop_bypass_accepted` | Handler rewrites needs_human to continue; HTTP 200, active objective without the required stop | 1 |

These are explicitly injected fixture/runtime/blob/SQL faults. Production
source does not read `PLAN_REPLAY_FAULT`. The unknown-effect fault measures
loss of the ledger signal; it does not claim production ignored an effect that
was still recorded as unknown. Normal control requests use the existing
production API/ingestion/admission chain. Fault setup and terminal/reconcile
scenarios also use explicit test SQL and the current production advance hook;
the report does not claim every transition originated from HTTP alone.

Coordinator commands, cwd repository root:

```powershell
& 'D:/nodejs/node.exe' --test agent-harness/plan-replay/report.test.mjs
# final: exit 0, 8 passed, 0 failed, 0 skipped

& 'D:/nodejs/node.exe' node_modules/typescript/bin/tsc -p apps/scheduler/tsconfig.json --noEmit --pretty false
# exit 0

& 'D:/nodejs/node.exe' agent-harness/plan-replay/negative.mjs
# exit 0: 7/7 negative regressions verified
# every child replay gate: exit 1; every isolated SQL fixture: 1 test passed

& 'D:/nodejs/node.exe' agent-harness/plan-replay/run.mjs
# exit 0: 1 SQL fixture test passed; 17/17 replay outcomes matched
```

Each fixture process creates/drops its own randomly named database through the
existing fixture helper. The supplied database is not the application test
database. Evidence bytes are captured before fixture DB/blob cleanup. No model
or provider call is involved. Launcher/test failures, missing observations and
malformed baselines remain failures; no expected outcome was relaxed to accept
a replay difference.

## Scope and source review

Owned implementation is restricted to `agent-harness/plan-replay/**`, the new
`apps/scheduler/src/plan-replay-v2.integration.test.ts`, and the existing direct
Web Plan test `apps/web/src/plan-gap-report.test.ts`.

The coordinator reviewed AGENTS, `.agents/skills/architecture-doc-sync/SKILL.md`,
`.v062-parent-input/PLAN-IMPLEMENTATION-RESULT.md`, current Plan schemas and
execution/decision/output sources, DESIGN, the architecture ownership and
traceability entries, the two current Plan topic documents, and CI script and
artifact definitions. Relevant existing requirements are FR-CAP-006,
FR-HUB-002/003/005, FR-RPT-001, and the FR-TASK-007 association.

Global architecture, indexes, ADRs, schema/version, shared/backend implementation,
root scripts and workflows are outside this task's edit ownership. The parent
must integrate their current-v2 documentation and test wiring. This work does
not create a new architecture, change authorization, or establish model quality.

## Web result

No current Web production Plan reader has a hardcoded v1 visibility restriction.
The existing report projection already parses current v2 and historical v1.
The added behavior test renders a v2 Plan/result with a historical v1 entry and
checks visible task/result text and ordinary non-Plan Markdown preservation.

Coordinator verification, all using installed dependencies:

```powershell
# cwd: apps/web
& 'D:/nodejs/node.exe' 'node_modules/tsx/dist/cli.mjs' --test src/plan-gap-report.test.ts src/task-workbench/task-trace.test.ts src/session-viewer/parseAgentSession.test.ts src/session-viewer/sessionViewerModel.test.ts src/session-viewer/SessionViewer.test.ts
# exit 0: 60 passed, 0 failed, 0 skipped

# cwd: apps/scheduler
& 'D:/nodejs/node.exe' 'node_modules/tsx/dist/cli.mjs' --test src/file-size.test.ts src/docs-freshness.test.ts src/plan-gap-projection.test.ts ../../apps/web/src/searchable-select-model.test.ts ../../apps/web/src/searchable-select-adoption.test.ts ../../apps/web/src/runtime-image-option.test.ts
# exit 0: 43 passed, 0 failed, 0 skipped
```

The Web worker also ran its local TypeScript check successfully:
`D:/nodejs/node.exe node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
from `apps/web`. Its initial package-script attempt failed at pnpm's selected
9.15.9 signature check before tests. No package/lock/dependency files changed;
the worker did not retry, purge, install, or refetch. The direct commands above
are the actual test evidence and require no package-manager bootstrap.

## Parent CI wiring

Existing workflow `.github/workflows/ci.yml` runs `ci:unit:plan-replay` and
`ci:integration:plan-replay` and uploads `artifacts/plan-replay/*.json` as
`plan-offline-replay`. The existing integration script invokes `negative.mjs`
then `run.mjs`; those entry points remain the delivery contract.

The new scheduler integration file is executed by the replay launcher, but
`ci-test-hook-gate.ts` only scans package scripts and workflows. Before tracking
and merging it, the parent must explicitly reference
`src/plan-replay-v2.integration.test.ts`, for example in
`ci:integration:plan-protocol`. That root file is outside this task's scope.
The Web test already belongs to `ci:unit:plan-protocol`.

## Backend-owned bootstrap visibility gap

This is a source finding, not a runtime/model test result:

- `executor-real.ts`, `taskGoal` (line 849 in the reviewed tree), selects
  `taskTarget.goal/content/title` and omits `taskTarget.plan_objective`.
  The Hub initial input uses that value at line 884.
- `graph.ts`, `boundedJson` and initial projection (lines 96 and 354-367),
  places the objective only inside the general target, bounded to 480
  characters for Hub overview or 2,400 otherwise. It can therefore be omitted.
- `graph-query.ts`, `projectOverview` (lines 503-550), projects only target
  kind/title. `projectNodeBody` (lines 334-355) omits root `body.target`.
- `domains/plan-protocol/gap-query.ts` calls `readPlanObjective`; that reader
  requires an already accepted explicit Plan audit (`objective.ts:168-185`).
  It cannot bootstrap the first current Plan from the persisted user objective.

Minimal proposed parent fix: expose the validated current objective's identity,
revision, goal, completion and budget through the existing bounded Hub initial
projection and a pre-Plan graph read path. Ensure complete field retrieval within
explicit bounds. A goal-only fallback cannot provide completion/budget identity.
Keep accepted-Plan criteria reads separate and preserve existing authorization.
No backend source was changed here. The replay fixture receives its objective
from the authorized task PATCH response, so it does not prove Hub bootstrap.

## Limits

No remote CI, production execution, real provider/model call, independent human
quality evaluation, capacity or SLA result is claimed. No Git staging, commit,
push, PR, external message, tag, release, deployment, or other worktree change
was performed. Existing `.pnpm-store` and `.v062-parent-input` remain unrelated
untracked input/output and are not delivery files.
