# Skill applicability evidence preflight (#778)

Status: **offline engineering preflight**, not Phase B completion, a recommendation
endpoint, or effectiveness validation. This slice is independent of the partial
Phase A evidence report. It has no database, network, model, execution, ranking or
ledger writes. It only reads one bounded local JSON file and prints a report.

The report answers: do one exact local Skill's author-declared constraints match
this frozen input, and do independently identified expected/actual JSON bytes
compare equal? It cannot determine whether the author described the Skill
correctly, authenticate exported provenance, establish causal benefit, or grant
current authorization. A matching synthetic case is engineering evidence only.

## Reproduce the synthetic case

```sh
node agent-harness/capability-applicability/fixture.mjs > /tmp/applicability-input.json
node agent-harness/capability-applicability/fixture.mjs --digest
node agent-harness/capability-applicability/preflight.mjs /tmp/applicability-input.json <recorded-digest>
node --test agent-harness/capability-applicability/*.test.mjs
```

`fixture.mjs` specifies an ASCII whitespace example, a manually fixed expected
JSON value, and actual JSON produced by a small local JavaScript normalization
expression. UUIDs and runtime digest are synthetic, not platform-created Jobs or
admitted images. The file is the complete input example. It is not a model answer
or a generic assertion executor. Nothing in this tool runs the supplied Skill.

Exit codes: `0` compatible, `1` incompatible, `2` unknown/unreadable. All nonzero
results must stop dependent work. Stable `reasons` are machine-readable codes;
untrusted names, text, raw expected/actual values and errors are not echoed.

## Strict contract and source mapping

`contract.mjs` is the exact v1 contract. Unknown fields are rejected at every
structured level, including sidecars and candidate metadata. Missing data is not
silently defaulted. All hashes are lowercase SHA-256. A `seal` binds canonical JSON
body bytes; the separately supplied envelope digest must match before analysis.
The CLI opens with `O_NONBLOCK`, checks `fstat` for a regular file and size,
then reads at most 1 MiB + 1 byte to detect growth after the check. It closes the
descriptor on every path and never prints path/OS errors. FIFOs and devices are
not supported. Limits: 1 MiB input file and canonical envelope, 1,000 catalog/version entries, 20 safe Skill text
paths / 128 KiB path-and-content bytes, 64 KiB per JSON byte string, depth 24.

| Input | Existing source / explicit research input |
| --- | --- |
| `job.body.id/project_id/timeout_sec` | Matching columns of one `jobs` row |
| `job.body.agent_snapshot_json.runtime_image.image_digest` | Frozen admitted image digest |
| `...platform_tools`, `...network_policy.allow_egress` | Existing frozen operation/network fields; no default values |
| `...project_knowledge_catalog.entries/hash` | Complete existing `FrozenKnowledgeCatalog`, including Memory and exact foreign grants |
| `attempt.id/job_id` | Matching `job_attempts` row |
| `time_budget.job_id/started_at/captured_at` | Same Job `jobs.started_at` and pinned observation time, used to calculate remaining seconds |
| `token_budget.job_id/max_tokens/used_tokens/captured_at` | Numeric-only projection of the operator-selected current Job token; no token, credential or other secret fields |
| `skill` identity/creator fields | `project_knowledge_versions` (`id` exported as `version_id`) and its project/item/version identity |
| `skill.candidate` | Complete immutable `KnowledgeCandidate` CAS JSON, with `kind=skill` |
| `authorization.body.entries` | Version rows: `id/project_id/item_id/version/content_sha256/revoked_at` |
| `input.kind/target_version/json/sha256` | Preregistered study input descriptor and canonical input bytes; not new Job fields |
| `declaration` | Versioned author sidecar bound to the complete candidate hash; not authoritative runtime metadata |
| `assertion` | Research expected/actual asset bytes, exact Skill/input/runtime binding, and consumer/trial/oracle Job/Attempt identities |

The `job` object is a **redacted export projection** of existing fields, not a new
runtime snapshot schema. `job.sha256` hashes that entire projection; the
authorization view's `job_projection_sha256` binds it. It is not the hash of the
full stored `agent_snapshot_json`, which may contain sensitive configuration and
must not be copied into this file. The complete knowledge catalog entries and
their original hash are retained unchanged, even though only one local Skill is
selected. Do not filter foreign entries or Memory and recalculate that hash.
Unrelated versions/grants do not enter results, counts or explanations.

`skill.content_sha256` uses the same canonical complete KnowledgeCandidate bytes
as `domains/project-knowledge/blobs.ts`, including title, logical key, keywords and
files. It is not an SKILL.md-only hash. The sidecar is outside the candidate to
avoid a self-referential hash. Names/descriptions and synthesized capability
manifest defaults are never used to infer applicability.

For `runtime_export`, the operator must capture authorized, consistent, isolated
source records and the corresponding CAS bytes, verify Job/Attempt/asset ownership
out of band, and pin the expected envelope digest before handing it to analysis.
`captured_at` must match the revocation view's time and the view must bind this
exact Job projection. A hash only detects changed bytes: it cannot authenticate
an exporter or prove a timestamp. The report always says
`operator_supplied_not_authenticated`; changing `mode` does not increase trust.
No production export or real-model run has been performed for this slice.

## Decision semantics

1. Require valid v1 structure and matching envelope, Job, complete catalog,
   candidate, authorization and declaration hashes. An unavailable or mismatched
   snapshot is unknown. Missing authorization state is never treated as unrevoked.
2. Select only the current project's exact Skill item/version/hash in both frozen
   catalog and exported current version state. Missing authorization or explicit
   revocation is incompatible. A foreign tested Skill/Job/sidecar produces only
   `SCOPE_DENIED`, without source identifiers, hashes or field-specific reasons.
3. Match author-declared input kind, exact target-version allowlist, runtime digest,
   required platform operations, network need and minimum token/time ceilings.
   A mismatch is incompatible. Missing or unknown token ceilings remain unknown.
   Token comparison uses `max_tokens - used_tokens`; time uses `jobs.timeout_sec`
   minus elapsed seconds since the observed `started_at`. Both observations must
   match the pinned capture time. Missing/future start or mismatched capture time
   is unknown; exhausted time is insufficient. These are exported counters, not
   authenticated Provider quota or live execution availability.
4. Require a context-bound assertion with distinct consumer, maker, trial and
   oracle Jobs/Attempts, distinct expected/actual assets and verified byte hashes.
   These are consistency checks, not authentication of IDs. Unknown external effect
   returns `UNKNOWN_EFFECT_RECONCILE_ONLY`; there is no retry or replay operation.
5. Compare canonical expected and actual JSON structurally. `pass`/confidence/
   claimed outcome fields are forbidden. Null/unobserved results are unknown;
   mismatched bytes/hashes, malformed JSON, duplicate-key or noncanonical JSON are
   unknown. A real expected/actual difference is incompatible even if every author
   constraint matched. A match is compatible **only for this frozen offline case**.

Author constraints and observed JSON equality are separate report sections.
`effectiveness=not_evaluated`, `live_authorization=not_checked`, and
`recommendation=null` always remain. No favorable rate, ranking, generalized
applicability or causal effectiveness is derived, and no current authorized
catalog is returned. The original platform live revocation checks still own reads.

## Validation and next gates

Reader/CLI tests cover regular and sparse oversized files, directories, injected
nonregular files, short reads, growth after stat, I/O errors and descriptor closure
without opening actual devices or FIFOs. Behavior tests cover synthetic equality, unknown fields, missing inputs, exact
identity, preserved mixed catalogs, historical versions, input/runtime/tool/network/
budget mismatches, revocation, cross-project suppression, changed hashes, producer
separation, raw JSON differences and unknown effects. The suite is added to
`pnpm ci:unit:project-knowledge`, already called by `.github/workflows/ci.yml`.

This does not consume or allocate `job_usage_ledger`, invent an Experience ledger,
replace work/receipt/replay, or use #770 Finding relations for authorization or
recommendation. Objective business assertions beyond one JSON equality predicate,
trusted runtime-export acquisition, actual usage observations and prospective
quality/cost comparison remain future work. No schema, OpenAPI or runtime operation
changes occur here. A future current-Job suggestion API still needs shared
schema/OpenAPI review, live scope/revocation filtering and evidence disclosure
rules; this preflight must not be exposed as a substitute.
