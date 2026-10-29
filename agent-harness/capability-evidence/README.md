# Capability / Skill evidence audit (#778 A)

Status: offline report implementation; no recommendation policy or real-model effect evaluation.

The report projects existing `jobs.agent_snapshot_json`, `job_attempts`,
`project_knowledge_versions`, `project_knowledge_usages` and
`project_knowledge_receipts`. It adds no ledger, execution path, database schema,
Control API or model request. It does not reuse #770 Finding relations as evidence
of authorization or benefit.

## Reproduce

On an independently authorized **isolated research database**, use `export.sql`
with a read-only account and one explicit project UUID. The read-only repeatable
read transaction captures Jobs and revocation state consistently. This task did
not run the SQL against a database. Never point it at production. Each table is
bounded at 10,001 rows; the analyzer rejects exports above 10,000 instead of
silently publishing incomplete denominators. Use a new isolated study if needed.
The export contains scoped metadata and evidence references: protect it as research
data, do not publish it as a public fixture. It excludes credential values, full
runtime snapshots, feedback prose, session text and evidence bodies.

```sh
psql "$TEST_DATABASE_URL" -X -qAt -v project_id='<isolated-project-UUID>' -f agent-harness/capability-evidence/export.sql > export.json
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {sourceDigest} from "./agent-harness/capability-evidence/report.mjs"; console.log(sourceDigest(JSON.parse(readFileSync("export.json", "utf8"))))'
node agent-harness/capability-evidence/report.mjs export.json <recorded-source-digest> > report.json
node --test agent-harness/capability-evidence/report.test.mjs
```

Record the digest with the study manifest before analysis. It detects changed
input, not malicious provenance: only a trusted export can establish provenance.
No cache or stored projection is written. Identical exports rebuild identically;
changed exports require a new digest and report. An old report is a historical
audit, never an authorization token. Live revocation must still use existing
`visibleKnowledgeEntries` / `loadJobSkillCatalog` on every read. Export timestamp
cannot prove that authorization has not changed since export.

## What the report means

| Signal | Report interpretation |
| --- | --- |
| Local Skill in frozen catalog and unrevoked matching version | Catalog membership; actual exposure and selection reason unknown |
| Exact selector/hash/version plus matching Job/Attempt usage | Observed pull/read only |
| Usage feedback | Model-declared outcome and reference count; references are not independently verified |
| Same Job/Attempt settled feedback receipt | Feedback accepted by platform, not a quality verdict |
| `capability_pack` snapshot | Frozen configured combination ID/version/digest; not an observed Agent recommendation |
| Job succeeded | Execution terminal state; independent quality remains unknown |

Counts use local Skill×Job pairs. Multiple Attempts remain visible but do not
inflate pair denominators. Missing/invalid join identity cannot borrow another
version's or Attempt's outcomes. Revoked local versions and foreign-project
records do not enter Skill records/counts. Explicit cross-project byte grants do
not authorize sharing source outcome counts, so cross-project effects are omitted.
Global Skill CAS expansion is not covered. Configured Pack records are historical
configuration audit only, never candidates or current authorization decisions.

No claim of actual execution, independent effectiveness, failure cause or cost
savings is made. Independent quality rate is null, not zero. Combination effects
are not distributed to members. Unknown external effects are not retried; this
tool has no network or replay execution capability.

## Remaining gates

Phase A is partial: selection rationale/exposure observations, global Skill
materialization, independently checked usage evidence and objective outcome/cost
association still need source-backed integration. Existing Hub replay and
`job_usage_ledger` remain authorities for their own execution/cost records; this
report does not duplicate or allocate their totals to skills without attribution
evidence. Missing failure categories remain unclassified.

Phase B requires current Job catalog plus read-time revocation, applicability,
authorization and bounded pagination reviewed through shared schema/OpenAPI.
No suggestion API is exposed here. Phase C needs preregistered criteria, frozen
paired cases, independent labels/executable assertions, approved isolated model
configuration and explicit cost/time limits. Low samples, injection, unauthorized
selection or quality regressions cannot be compensated by token savings. Model
routing, production exploration and Pack promotion remain outside this slice.
