# Scheduler bounded contexts and lock matrix

This note records the dependency and lock contracts for the incremental
Scheduler split tracked by Issue #37.  It is intentionally a design boundary,
not a schema or API change.  PostgreSQL and the Scheduler remain the only
execution-state and side-effect authority.

## Context map

The Scheduler is being split by responsibility.  Each context exposes a small
application interface; a caller must not update another context's rows by
reaching through its implementation module.

| Context | Owns | Does not own |
| --- | --- | --- |
| `job-lifecycle` | Job status policy and the guarded `jobs` status update; claim/provision/run/finalize/resume/cancel/retry orchestration will migrate here incrementally. | Canvas convergence, Finding verdicts, Report artifacts, RoleConfig/runtime resolution. |
| `event-ingestion` | Event envelope validation, event-id deduplication, per-Job sequencing, and dispatching semantic side effects. | The policy for a Job status transition. |
| `hub-orchestration` | Hub eligibility, intent validation, round budgets, idle/complete progression. | Direct Job status writes; it requests a lifecycle transition. |
| `finding-verification` | Verification rounds, evidence gates, rework/needs-human/confirmed decisions. | Dispatcher claims and Report state. |
| `report-convergence` | `analysis_complete`/`reporting` gates, report input, SARIF output, and report failure recovery. | Agent runtime snapshots or generic Job transition rules. |
| `role-runtime-snapshot` | RoleConfig, credential/CLI compatibility, skills, and immutable runtime-image snapshots. | Canvas/Finding convergence and Job terminal decisions. |

The route layer is an adapter over these application interfaces.  `core.ts`
currently remains the compatibility composition root while the other contexts
move out in later Issue #37 slices.

## Lifecycle foundation and dependency direction

The first slice puts the pure policy in
`apps/scheduler/src/domains/job-lifecycle/transition-policy.ts` and the
PostgreSQL adapter in `application.ts`:

```text
dispatcher / routes / reaper / reconcile
                 |
                 v
       core.ts compatibility facade
                 |
                 v
 job-lifecycle application seam -----> PostgreSQL adapter (`db.ts`)
                 |
                 v
       pure transition policy (no imports)
```

The policy has no Scheduler or database imports.  The application seam accepts
an executor callback, so the legal/illegal transition matrix and stale-terminal
behavior can be characterized without a live database.  The SQL adapter keeps
the existing linearization point: `UPDATE jobs ... WHERE status = ANY(...)`.
A `null` update is a lost race/no-op and callers must not run follow-up work.

The compatibility facade deliberately exports the historical
`core.ts` `canTransition` and `transitionJob` names.  No route, event, OpenAPI,
schema, or external status value changes in this slice.

## Canonical lock matrix

When a transaction touches more than one lockable resource, acquire locks in
the following order.  A path that only performs the lifecycle CAS acquires the
Job row and must not opportunistically acquire a Canvas lock.

| Operation | Canonical acquisition order | Contract |
| --- | --- | --- |
| Dispatcher claim | `deepsonar_dispatch_claim` transaction advisory lock → candidate `jobs` rows (`FOR UPDATE SKIP LOCKED`) | The advisory lock serializes claim/retry and other runtime mutations; keep the candidate page bounded. |
| Destructive canvas retry | `deepsonar_dispatch_claim` → `canvases` row (`FOR UPDATE`) → Job/runtime rows and canvas nodes | Re-check active Jobs after both locks; never wipe runtime rows from the preflight read. |
| Event ingestion | Job row (`FOR UPDATE`) → `event_dedup` unique insert → `events` sequence/insert → semantic side effects | The Job row serializes `MAX(job_seq)+1`; duplicate `event_id` returns before side effects. |
| Convergence terminal/recovery | `canvases` row (`FOR UPDATE`) → `findings` row (`FOR UPDATE`) → `finding_verification_rounds` row (`FOR UPDATE`) → Jobs/nodes | Canvas is the outer convergence lock; Verify and Hub paths use the same canvas-first order. |
| Report ingress/recovery | `canvases` row → `task_reports` row → report Job/nodes | Matches `report.ts`'s existing `canvas → task_reports → jobs/nodes` contract. |
| Credential/runtime mutation | `deepsonar_dispatch_claim` → Credential row (`FOR UPDATE`) → dependent RoleConfig/Job reads | Prevents a runtime snapshot from observing a half-applied provider/credential mutation. |

The same resource must never be acquired in a reverse order in another path.
In particular, a new lifecycle implementation must not lock a Finding or
Verification round before its Canvas.  The current `finalizeJob` body retains
its pre-existing Job CAS and side effects for behavior compatibility; moving
that orchestration behind the canvas-first lifecycle application boundary is a
follow-up slice and must be accompanied by a deadlock/regression test.

## Migration rules

1. Add a narrow application method before moving a caller; leave a
   `core.ts` facade until all call sites have migrated.
2. Keep transaction ownership explicit.  Domain policy code must remain pure;
   SQL adapters receive the transaction/connection from the caller where a
   larger transaction is required.
3. Add characterization coverage for every moved terminal/recovery path before
   changing its lock acquisition or side-effect ordering.
4. Do not add dynamic imports merely to hide a dependency cycle.  If a real
   cycle remains, introduce an interface at the bounded-context boundary and
   make the dependency direction visible in this document.
