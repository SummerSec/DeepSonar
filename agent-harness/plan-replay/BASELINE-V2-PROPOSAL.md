# Plan v2 replay baseline proposal

Version: `v2`
Baseline file: `baseline-v2.json`
Expected contract commit: `4844cf74d46b6da76ef9e6702cac062a22a15bbe`

This proposal is frozen before any current-v2 replay is run.  The existing
`baseline.json` and its SHA remain the immutable v1 history and are not used as
the v2 oracle.  The v2 gate measures only the current v2 Control API,
event-ingestion, Intent admission, Job/Attempt, retained Evidence, and Plan
decision paths.  It is a synthetic engineering regression, not a model-quality
or production result.

## Source and fixture mapping

The v2 executable fixture is the existing
`apps/scheduler/src/plan-execution-test-fixture.ts`.  It starts Fastify with the
production `routes`, Control API, event ingestion, graph query, and Plan
materialization modules, then creates a random PostgreSQL database from
`TEST_DATABASE_URL` and a random temporary blob root.  `fixture()` creates a
random project/canvas/Hub owner, `submit_plan` is sent through the HTTP Control
route, and `emit()` writes a real Attempt-scoped evidence file plus finalized
manifest before sending `emit_fact`.  `finish()` uses the real
`mark_job_done` Control operation.  The fixture closes the app/sql clients and
drops only its random database and blob root.

The exact frozen error expectations were set from source before replay:
`domains/plan-protocol/application.ts:266` for `plan_source_unavailable`,
`domains/event-ingestion/side-effects.ts:1100-1105` for forbidden system
roles (`tool_not_allowed`, fail-closed HTTP 409),
`domains/event-ingestion/completion-receipt.ts:131` for the host completion
boundary (`COMPLETION_EFFECT_UNKNOWN`, HTTP 409), and
`domains/plan-protocol/decision.ts:67,83` for `plan_completion_unproven`.

The new replay integration test will record JSONL rows only after it has read
the actual HTTP response and SQL rows.  Every trace keeps the random
`job_id`/`attempt_id`, Job/Attempt statuses, evidence URI, byte count and SHA,
and the relevant event/artifact identity.  The compared `observed` projection
contains only deterministic fields; trace identity is retained alongside it
and is never treated as an assertion count.

## Frozen case oracle

The cases in `baseline-v2.json` cover the following current-v2 contract
boundaries independently:

- normal Plan v2 dispatch and exact output association with a successful
  Attempt, finalized bytes, and a released two-task dependency;
- idempotent route replay without a second child or Plan event;
- current Canvas/source scope admission and system-role admission (the
  forbidden worker-role path is the fail-closed `409/tool_not_allowed`
  contract);
- stale route and stale Canvas input rejection without partial dispatch;
- historical v1 readback/refusal (v1 is readable history, not execution or
  completion input);
- retained output not being semantic completion authority by itself;
- truthful operator-authorized completion through the current decision gate;
- unknown external effects (the completion boundary reports
  `COMPLETION_EFFECT_UNKNOWN` before the fixture reconciles the Job), missing
  output, failure, timeout, cancellation and orphan terminal states stopping
  execution durably;
- no-progress and explicit human stop paths.

No row infers semantic success from child counts, `done` text, or a PlanResult
alone.  The positive operator case requires the current positive operator
bindings and a fresh `submit_hub_decision` response; the output-association case
does not claim completion.

## Negative fault matrix

`negative.mjs` runs the same real fixture with one named test-handler/trace
collector fault at a time.  The real HTTP/SQL/byte observation is always kept
in `observed` and `trace`; the fault changes the fixture/runtime/blob path so
the actual captured observation differs.  A fault is valid only when the
fixture reaches that case and the gate rejects that actual bad trace; a
missing DB, skipped test, launcher failure, or unrelated exception is not a
regression pass.  The report must be non-passing and must identify the
different case and retained real trace.

| Fault | Injected bad trace | Gate that must fail |
| --- | --- | --- |
| `unproven_completion_accepted` | test handler skips the completion preflight/ingestion and the actual HTTP receipt becomes 200 | truthful operator completion gate |
| `scope_cross_project_accepted` | test handler rewrites an out-of-scope source to an admitted root before ingestion; actual HTTP/SQL has an accepted Plan/child | Canvas/project source scope and atomic admission |
| `stale_route_accepted` | test handler ingests a corrected route while restoring the stale request bytes for receipt identity; actual HTTP is 200 | route/objective CAS |
| `unknown_effect_replayed` | explicitly labeled test-only SQL ledger-clear changes the inserted effect from `unknown` to `settled` before the real completion HTTP request; actual SQL/HTTP follows that unsafe continuation and records before/after status | unknown external effect stop |
| `evidence_bytes_fabricated` | fixture mutates the Attempt file after `emit_fact`; the real completion/output gate reads the changed bytes | retained-byte/evidence authority |
| `system_role_accepted` | forbidden system-role task is rewritten by the test handler to an admitted worker role and returns 200 | system-role admission and atomic route validation |
| `stop_bypass_accepted` | a `needs_human` result is rewritten by the test handler to a continuing result and returns without the durable human stop | explicit stop boundary |

Faults are confined to the new integration test's fixture observation/handler
path.  Production code does not read `PLAN_REPLAY_FAULT`.  The negative
wrapper requires a non-zero replay gate, `report.passed === false`, the named
case as `different`, and no prerequisite/launcher failure classification.
