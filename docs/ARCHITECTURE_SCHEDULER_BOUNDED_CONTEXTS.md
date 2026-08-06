# Scheduler bounded contexts and lock matrix

This note records the dependency and lock contracts for the incremental
Scheduler split tracked by Issue #37.  It is intentionally a design boundary,
not a schema or API change.  PostgreSQL and the Scheduler remain the only
execution-state and side-effect authority.

## Context map

The Scheduler is split by responsibility.  Each context exposes a small
application interface; a caller must not update another context's rows by
reaching through its implementation module.

| Context | Owns | Does not own |
| --- | --- | --- |
| `job-lifecycle` | Job status policy plus guarded application operations for claim, execution failure, timeout/orphan/reconcile recovery, cancel (single/bulk), resume, and runtime-image cancellation. | Canvas convergence, Finding verdicts, Report artifacts, RoleConfig/runtime resolution. |
| `event-ingestion` | Event envelope validation, event-id deduplication, per-Job sequencing, and dispatching semantic side effects. | The policy for a Job status transition. |
| `hub-orchestration` | Hub eligibility, intent validation, round budgets, idle/complete progression. | Direct Job status writes; it requests a lifecycle transition. |
| `finding-verification` | Verification rounds, evidence gates, rework/needs-human/confirmed decisions. `application.ts` exposes the close/evidence/gate seam; `routes.ts` owns read-only Finding and verification projections. | Dispatcher claims and Report state. |
| `report-convergence` | `analysis_complete`/`reporting` gates, report input, SARIF output, report failure recovery, and report/download route registration. | Agent runtime snapshots or generic Job transition rules. |
| `role-runtime-snapshot` | RoleConfig, credential/CLI compatibility, skills, and immutable runtime-image snapshots. | Canvas/Finding convergence and Job terminal decisions. |

The route layer is an adapter over these application interfaces. Business
handlers live in domain registrars; top-level `routes.ts` installs shared hooks
and composes those registrars. `core.ts` remains the compatibility composition
root for established internal imports. Legacy SQL implementations are injected
through explicit ports so application seams can be tested without a database
and transaction ownership remains visible.

## Lifecycle foundation and dependency direction

The first slice puts the pure policy in
`apps/scheduler/src/domains/job-lifecycle/transition-policy.ts` and the
PostgreSQL adapter in `application.ts`:

```text
dispatcher / routes / reaper / reconcile
                 |
                 v
 job-lifecycle application seam -----> PostgreSQL adapter (`db.ts`)
                 ^
                 |
       core.ts compatibility facade (remaining convergence writers)
                 |
                 v
       pure transition policy (no imports)
```

The policy has no Scheduler or database imports.  The application seam accepts
an executor callback, so the legal/illegal transition matrix and stale-terminal
behavior can be characterized without a live database.  Its SQL adapter also
owns explicit legacy recovery and bulk cancellation guards; callers inject
their existing transaction client when a larger lock sequence is in progress.
The generic transition keeps the existing linearization point:
`UPDATE jobs ... WHERE status = ANY(...)`.  A `null` update is a lost race/no-op
and callers must not run follow-up work.

The compatibility facade deliberately exports the historical
`core.ts` `canTransition` and `transitionJob` names.  No route, event, OpenAPI,
schema, or external status value changes in this slice.

## Canonical lock matrix

The rows below are the **target contract** for the incremental split.  A path
that only performs the lifecycle CAS acquires the Job row and must not
opportunistically acquire a Canvas lock.  A path that can update a Canvas must
enter the Canvas-first convergence boundary before it takes a Job lock.  The
event-ingestion application now implements both variants: Job-only events keep
the small Job lock, while Canvas-aware events acquire Canvas before Job and run
append plus semantic side effects in one transaction.  The terminal path in
`core.ts` follows the same Canvas-first boundary.  Never acquire Canvas under an already-held Job lock.

| Operation | Canonical acquisition order | Contract |
| --- | --- | --- |
| Dispatcher claim | `deepsonar_dispatch_claim` transaction advisory lock → candidate `jobs` rows (`FOR UPDATE SKIP LOCKED`) | The advisory lock serializes claim/retry and other runtime mutations; keep the candidate page bounded. |
| Destructive canvas retry | `deepsonar_dispatch_claim` → `canvases` row (`FOR UPDATE`) → Job/runtime rows and canvas nodes | Re-check active Jobs after both locks; never wipe runtime rows from the preflight read. |
| Event ingress (Job-only) | Job row (`FOR UPDATE`) → `event_dedup` unique insert → `events` sequence/insert → job-only side effects → **commit** | The Job row serializes `MAX(job_seq)+1`; duplicate `event_id` returns before side effects. |
| Event ingress (Canvas-aware target) | Canvas row (`FOR UPDATE`) → Job row (`FOR UPDATE`) → Job/Intent/Report target rows (`FOR UPDATE`) → `event_dedup` unique insert → `events` sequence/insert → Canvas/Finding/Hub side effects → **commit** | The append and semantic effects are one atomic transaction, so a side-effect failure rolls back the append and dedup marker. The preflight Canvas hint carries its source/target and node snapshots; all are rechecked under the ordered locks. A changed target retries once and then fails closed; no reverse lock is taken. |
| Convergence terminal/recovery | `canvases` row (`FOR UPDATE`) → `findings` row (`FOR UPDATE`) → `finding_verification_rounds` row (`FOR UPDATE`) → Jobs/nodes | Canvas is the outer convergence lock; Verify and Hub paths use the same canvas-first order. |
| Report ingress/recovery | `canvases` row → `task_reports` row → report Job/nodes | Matches `report.ts`'s existing `canvas → task_reports → jobs/nodes` contract. |
| Credential/runtime mutation | `deepsonar_dispatch_claim` → Credential row (`FOR UPDATE`) → dependent RoleConfig/Job reads | Prevents a runtime snapshot from observing a half-applied provider/credential mutation. |

The same resource must never be acquired in a reverse order in another path.
In particular, a new lifecycle implementation must not lock a Finding or
Verification round before its Canvas, and no event side effect may take Canvas
under a held Job lock.  `finalizeJob` now reads the Job's Canvas target and the
complete Job/Intent/Report node Canvas set, rejects multi-Canvas or Job/Canvas
conflicts, acquires the unique Canvas, and only then performs the guarded Job
update after a locked node-set recheck; Verify, Hub, and Report work continue
underneath that outer Canvas lock.  The
event-ingestion callback is invoked only after the ordered locks are held, so
duplicate replay and a callback failure cannot produce an append/side-effect
split-brain.  The semantic callback implementation now lives in the
event-ingestion side-effect application and receives Hub, Finding, runtime
snapshot, shared-asset, and terminal/report adapters through explicit ports;
this extraction does not change the lock-order contract.

## Event-ingestion second slice

`apps/scheduler/src/domains/event-ingestion/application.ts` owns envelope
validation, payload limits, event-id deduplication, and per-Job sequencing.
`side-effects.ts` owns the semantic callback behind typed ports; `core.ts`
remains the compatibility facade and composition root.  The application
performs a read-only Canvas hint preflight, then re-checks the Job row and the
target/Job/Intent/Report node snapshots with row locks after acquiring
locks (`Canvas → Job → nodes`) and retries once if legacy data was reassigned
concurrently.  Both the append and callback run before the
transaction commits; an exception rolls back `event_dedup`, `events`, and all
side effects without requiring a schema marker.  The integration coverage
exercises duplicate replay, concurrent sequence allocation, rollback/retry,
node re-point races (including fact intent targets), inconsistent multi-Canvas
terminal rejection, and a concurrent terminal event/finalize path to guard
this boundary.

## Lifecycle patch contract

The application seam rejects a `patch.status` property before invoking its
executor.  The target is supplied by the explicit `to` argument, so a metadata
patch cannot override the guarded state transition.  Existing internal callers
pass only metadata fields (`started_at`, lease, error, and similar); the
characterization test keeps this boundary explicit before the interface is
adopted by additional contexts.

## Issue #37 Phase 0 — characterization and guardrails

Phase 0 is a behavior-preservation slice.  It does not move production logic,
change the database schema, or change an HTTP response.  Its purpose is to make
the current Scheduler composition measurable before bounded-context slices
start moving callers.

The CI gate now executes the following baseline:

1. The pure Job lifecycle matrix and terminal/recovery fixtures in
   `domains/job-lifecycle/*characterization.test.ts` (alongside the existing
   lifecycle tests).
2. The semantic direct-status-write inventory in
   `job-state-write-inventory.test.ts`.  It enumerates the guarded status
   writers in every production TypeScript module under `apps/scheduler/src`
   (recursive; `*.test.ts` files and the canonical adapter are excluded); an
   unclassified `UPDATE jobs ... SET status` fails the test.  The generic
   `job-lifecycle/application.ts` SQL CAS is checked separately as the
   canonical adapter.  It records the intentional legacy recovery exceptions
   (Reaper `claimed/provisioning/running → timeout` and boot reconcile
   `claimed/provisioning → pending`) as application-owned operations rather
   than pretending they are pure policy edges.
3. The Fastify registrar and OpenAPI operation manifests in
   `route-surface.manifest.ts`, exercised by `route-surface.test.ts`.  The
   test observes the actual `onRoute` registrations, so a later registrar split
   cannot silently drop an endpoint.  The current documented/undocumented
   OpenAPI surface is captured intentionally; changing either surface requires
   an explicit manifest diff.

Phase 0 closes when these checks are green in the repository CI gate and the
manifest contains no unexplained route or status-writer drift.  Subsequent
slices may then move one bounded context at a time (event-ingestion, Hub
orchestration, Finding verification, report convergence, and role/runtime
snapshot), keeping `core.ts` as a compatibility facade until each caller has
an application seam.  Each slice must add characterization for its moved
terminal/recovery path before changing lock order or side-effect sequencing.

## Issue #37 Phase 1 — Job lifecycle callers migrated

Phase 1 closes the lifecycle-owned status-writer boundary without changing the
schema, HTTP surface, or side-effect ordering.  `dispatcher.ts`, `reaper.ts`,
`reconcile.ts`, and the lifecycle routes in `routes.ts` now call explicit
application methods from `domains/job-lifecycle/application.ts`; the SQL adapter
receives the caller's `postgres` transaction client where applicable.  Reaper's
multi-source execution timeout and reconcile's multi-source provision requeue
remain named recovery methods because they are scheduler-recovery decisions,
not pure policy edges.  Canvas archive/delete, canvas cancel-active, and
runtime-image revocation use bulk `UPDATE ... RETURNING` operations so side
effects run only for rows that won the CAS.

The Phase 0 inventory intentionally still lists these direct writers in
`core.ts`: `finalizeJob` (`running → succeeded/failed`) and Verify priority
drain (`pending → cancelled`). `request_human` is now owned by the
event-ingestion side-effect application. Finalization and priority drain remain
coupled to Canvas/Finding/Report convergence. Phase 1 remains a historical
milestone and does not by itself describe the later completed slices.

## Issue #37 completion

All six execution contexts now expose explicit application/ports seams. The
event-ingestion context owns semantic side effects, while `core.ts` composes
Finding, Hub, runtime snapshot, shared-asset, edge, and terminal services and
keeps narrow compatibility exports. HTTP business handlers are registered by
domain; top-level `routes.ts` contains only shared auth/project-scope hooks,
Gateway registration, and registrar composition.

Characterization tests enforce the direct Job-status writer inventory, event
side-effect ownership, transaction-preserving facades, top-level route shape,
Fastify route surface, and OpenAPI operation surface. PostgreSQL integration
tests cover lifecycle recovery, event ordering/rollback/authorization/rate
limits, Hub reference validation, Verify rework, and convergence recovery.
Production Scheduler sources contain no dynamic `import()` used to evade a
dependency cycle.

## Migration rules

1. Add a narrow application method before moving a caller; leave a
   `core.ts` facade until all call sites have migrated.
2. Keep transaction ownership explicit.  Domain policy code must remain pure;
   SQL adapters receive the transaction/connection from the caller where a
   larger transaction is required.
3. Add characterization coverage for every moved terminal/recovery path before
   changing its lock acquisition or side-effect ordering.
4. Do not add dynamic imports merely to hide a dependency cycle. Internal
   `await import("./...")` workarounds are prohibited; cross-context calls use
   static imports and the application/ports adapters documented above.
