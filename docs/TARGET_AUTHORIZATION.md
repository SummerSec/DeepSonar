> 状态：as-built（#767 只读目标授权；离线 HTTP/SQL 授权链已验证）
> 同步日期：2026-10-31

# Trusted target authorization

This document describes the Scheduler-owned target authorization adapter added for
the task-dispatch path. The authority check is read-only and does not probe a
target by performing an active write. The production fake executor only drives
the existing state-machine simulation. Target actions exist only in an isolated
test fixture; the authority credential is never used for those actions.

## Supported contract

The protocol is `deepsonar.target-authorization/v1`. Version 1 supports exactly
one target descriptor:

```text
reference-http/v1:<tenant>/<resource>
```

The action chain described by authorization is fixed and ordered:

```text
reference-http.save
reference-http.publish
reference-http.trigger
```

The authority request is created by the Scheduler. It contains the project ID,
target descriptor, Scheduler-authenticated principal ID, tenant, role, resource,
the exact action chain, required prerequisite IDs, content SHA-256, normalized
task-contract SHA-256, derived revision, and a bounded freshness request. The
authority response must repeat the same project, target, principal, identity,
binding, and every requested action with `allow`. Every required prerequisite
must be `satisfied`. A broad `read` grant is never converted into `write`.

The authority is a platform-owned read-only HTTP endpoint. A task, Canvas,
Job, Agent, or client cannot supply or replace its URL, authority ID, action
list, or secret reference.

## Platform configuration

Configuration is read only from the Scheduler host environment. The accepted
ranges and defaults are defined in the [configuration parser](../apps/scheduler/src/domains/target-authorization/contract.ts).

| Variable | Meaning |
| --- | --- |
| `DEEPSONAR_TARGET_AUTHORITY_URL` | Platform-owned HTTP(S) introspection endpoint. A missing URL leaves target-write contracts blocked. |
| `DEEPSONAR_TARGET_AUTHORITY_ID` | Stable authority identity. |
| `DEEPSONAR_TARGET_AUTHORITY_SECRET_REF` | Uppercase host environment variable name containing the secret. The secret value is never put in a request body, snapshot, feedback, or log. |
| `DEEPSONAR_TARGET_AUTHORITY_ACTIONS` | Optional comma-separated value. If present, it must be exactly the three action names above in the same order. |
| `DEEPSONAR_TARGET_AUTHORITY_MAX_AGE_SECONDS` | Maximum permitted response freshness. |
| `DEEPSONAR_TARGET_AUTHORITY_TIMEOUT_MS` | HTTP timeout. |
| `DEEPSONAR_TARGET_AUTHORITY_MAX_BODY_BYTES` | Maximum authority response body. |

The immutable Job snapshot stores the protocol, adapter, authority ID,
configuration identity, project/target/principal/tenant/role/resource, exact
actions, prerequisite IDs, content and contract hashes, revision, authority
revision, and expiry. It does not store the endpoint or secret. The
configuration identity includes the platform endpoint and secret reference, so
a changed platform authority fails closed instead of silently switching.
There is no production target-action endpoint or target-action client setting.

## Lifecycle gates

1. `POST /projects/:id/tasks` performs the current authority check before
   creating the Canvas or Job. A successful result is passed into the
   Scheduler-owned Job snapshot and recorded as a secret-free
   `task.target_authorization` system audit grant in the creation transaction.
   The existing creation schema strips unknown root fields: caller-supplied
   `target_authorization` is ignored and is never a source of authority.
2. Dispatcher rechecks the live authority before `provisioning`, sandbox
   creation or capability preparation. It sends the frozen
   authority revision as `expected_authority_revision`.
3. `resume-frozen` and `rerun-current` recheck before interrupting an active
   Attempt, revoking grants, changing Job state, or making the Job pending.
4. New child and system follow-on Jobs freeze a grant from the Scheduler-owned
   audit ledger, with the authoritative Canvas content/contract binding. A
   grant inserted into mutable Canvas metadata is ignored. Child payloads may
   omit original content; revalidation uses their frozen content hash and
   normalized contract hash rather than hashing an empty string.
5. `PATCH /tasks/:id` reauthorizes the proposed content/contract and appends a
   new host grant in the edit transaction. A failed check commits neither the
   edit nor a grant. Existing Job snapshots retain their original binding;
   future Jobs use the matching current host grant.
6. Invalid or changed host grant configuration returns the non-retryable
   `target_authorization_grant_invalid` error. Follow-on Hub/Report admission
   runs in a savepoint: rejection rolls back the follow-on batch, preserves the
   predecessor's terminal result, and pauses Canvas convergence with that
   reason. Plan dependency admission uses the same error to stop durably
   without undoing the predecessor's proven output.

Revocation, expiry, policy/revision change, identity or target mismatch,
unavailable prerequisites, malformed/oversized replies, timeout, redirect, and
missing platform secret all fail closed. The rejected path does not create a
root Canvas/Job. A live dispatcher rejection preserves the existing Job and
does not provision a sandbox. Rerun rejection does not interrupt the existing
Attempt or transition the Job.

## Reference fixture and limits

The local HTTP/SQL integration test in
`apps/scheduler/src/domains/target-authorization/target-authorization.integration.test.ts`
accepts only the test tenant, `editor` role, `save-publish-trigger` resource,
the fixture principal, and the exact save→publish→trigger action list. Its
authority endpoint returns a separate allow decision for each action and can
revoke the decision, change the policy/scope, or make a prerequisite unavailable.
The authority request contains hashes, never original task content or secrets.

This adapter does not claim that an arbitrary external target is writable. It
supports only the reference descriptor and the authority contract above. The
test-only client in `target-client.fixture.ts` requires an explicitly supplied
literal loopback HTTP endpoint and a separate public fake credential. It calls
only `/save`, `/publish`, and `/trigger`, bounds time/body size, and stops without
replay on a timeout. Production entry points do not import or export this client.

The positive test uses the real Fastify task route, Job capability token,
Control `submit_hub_decision`, semantic ingestion, Intent and child Job. A
test-only Worker driver then creates a genuine Attempt with a running lease,
rechecks current authority/prerequisites, calls the loopback fixture, retains
the actual HTTP results under that Attempt with a SHA-256 and manifest, and
submits Control `emit_fact` / `mark_job_done`. SQL verifies the Artifact/Evidence
projection, completion receipt, frozen child and system follow-on grants, and
PATCH immutability. This driver follows the existing Plan integration harness;
it does not provision a real sandbox or invoke a product model.

The revocation case uses the real `dispatchOnce` / `drainInFlight` path and
observes zero provision effects, zero runner provision calls, no sandbox and
no target actions. Resume and rerun rejection preserve the snapshot, Job state
and Attempt count. A subsequent dispatch does not replay the failed Job.
Revoked creation leaves Canvas/Job counts unchanged; a revoked PATCH preserves
the saved Canvas and host grants. The configuration-drift regression also
checks a real Dispatcher rejection with no other active Hub: the Job remains
failed, no partial follow-on Job or sandbox exists, and Canvas convergence is
paused. Every SQL run creates and drops its own
disposable database and removes its temporary evidence directory.

Parent verification on 2026-10-31: 37 combined contract/preflight/authorization
tests passed, including the real SQL/HTTP chain. After integrating Plan v2,
four SQL suites passed with no skips, including the new drift regression,
Plan output/dependency/stopping and objective CAS cases; 28 focused control,
Hub and snapshot tests also passed. These suites overlap and are not summed.
Scheduler typecheck and active LSP checks passed. Global scripts now include
the authorization unit test in `ci:unit:task-intent` and its SQL test in
`ci:integration:authz-boundaries`; final combined remote CI is still pending.
These are offline engineering observations, not production target execution
or model quality evidence.

Related requirements: [FR-TASK-006](architecture/01-system-specification.md#fr-task-006-版本化任务契约与派发前校验),
[FR-JOB-009](architecture/01-system-specification.md#fr-job-009-创建时冻结执行快照),
[CON-001](architecture/01-system-specification.md#con-001-四层真相和唯一副作用执行者)
and [NFR-REL-008](architecture/01-system-specification.md#nfr-rel-008-未知外部效果禁止猜测重放).
