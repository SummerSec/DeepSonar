# #775 current Plan v2 offline replay

This directory contains the frozen current-v2 SQL/HTTP replay gate.  `baseline.json` is retained as immutable v1 history only; the current runner reads `baseline-v2.json` and refuses a v1 baseline.

The integration fixture uses the production Fastify Control API, event ingestion, Plan v2 admission/materialization, Job/Attempt lifecycle, and graph projection.  It creates a random PostgreSQL database and temporary blob root through `plan-execution-test-fixture.ts`, records real HTTP responses and SQL rows, reads finalized Attempt evidence bytes/SHA before cleanup, and writes JSONL observations to the runner's private temporary file.  No model or production database is used.

Run the same commands used by CI:

```text
node --test agent-harness/plan-replay/report.test.mjs
node agent-harness/plan-replay/negative.mjs
node agent-harness/plan-replay/run.mjs
```

The launcher invokes `process.execPath` and the repository-local `apps/scheduler/node_modules/tsx/dist/cli.mjs`; it does not invoke pnpm or install/refetch dependencies.  `TEST_DATABASE_URL` is required.  `AGENT_MODE=fake` and the fixture master key are set by the fixture/runner without printing credentials or URLs.

Artifacts are written under the ignored `artifacts/plan-replay/` directory:

- `report.json` is the positive current-v2 gate report and contains the full 17-case denominator, actual trace identities, Attempt statuses, artifact/event references and retained evidence bytes/provenance.
- `negative-regression.json` records the named fault matrix.  A negative run is successful only when the fixture exits cleanly, the untampered cases match, and the explicitly labeled test-only runtime/SQL/blob fault makes exactly one actual case differ and causes the gate to exit non-zero.

The baseline is a control regression oracle.  It does not measure semantic goal omissions, model quality, model tokens, model time, adaptive improvement, production behavior, or C-stage activation.
