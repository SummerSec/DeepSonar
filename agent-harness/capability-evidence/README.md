# Capability / Skill evidence audit (#778)

Status: offline report implementation; no recommendation policy or real-model effect evaluation.

The report projects existing `jobs.agent_snapshot_json`, `job_attempts`,
`project_knowledge_versions`, `project_knowledge_usages` and
`project_knowledge_receipts`. It adds no ledger, execution path, database schema,
Control API or model request. It does not reuse #770 Finding relations as evidence
of authorization or benefit.

## Reproduce

On an independently authorized **isolated research database**, use `export.sql`
with a read-only account and one explicit project UUID. The read-only repeatable
read transaction captures Jobs and revocation state consistently. The integration suite executes this exact SQL against isolated PostgreSQL fixtures,
including runtime choice → pull → feedback. Never point it at production. Each table is
bounded at 10,001 rows; the analyzer rejects exports above 10,000 instead of
silently publishing incomplete denominators. Use a new isolated study if needed.
The export preserves the original frozen catalog metadata for digest verification;
choice and feedback fields use an explicit whitelist. Protect it as research
data, do not publish it as a public fixture. It excludes credential values, full
runtime snapshots, choice reason/target text, feedback prose, session text and evidence bodies.
Only export/report v2 is supported: regenerate exports instead of converting v1.
This changes no database schema and requires no database rebuild.

```sh
psql "$TEST_DATABASE_URL" -X -qAt -v project_id='<isolated-project-UUID>' -f agent-harness/capability-evidence/export.sql > export.json
node --input-type=module -e 'import {readBoundedInput} from "./agent-harness/capability-evidence/bounded-input.mjs"; import {sourceDigest} from "./agent-harness/capability-evidence/report.mjs"; console.log(sourceDigest(JSON.parse(readBoundedInput("export.json"))))'
node agent-harness/capability-evidence/report.mjs export.json <recorded-source-digest> > report.json
node --test agent-harness/capability-evidence/report.test.mjs agent-harness/capability-evidence/bounded-input.test.mjs
```

The CLI opens input nonblocking and checks the opened descriptor is a regular file
no larger than 16 MiB before reading. It reads at most 16 MiB plus one byte to
detect growth after the size check, handles short reads, and closes the descriptor
on success or failure. Rejections expose only the fixed error code, not paths,
input bytes or filesystem errors. Tests use temporary regular/sparse files and
directories plus mocked I/O; no real devices are read.

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
| Event-backed choice receipt | Ordered select/reject/none declaration; reason presence and receipt reference, not reason prose |
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

## Choice association and acceptance boundary

`choices` is ordered by the existing Job event sequence. The export joins receipt
and event by Job, Attempt, event identity, type and operation. Missing event
provenance is omitted; duplicate visible event sequences reject the input.
Policy/context/catalog binding and exact candidate identity must match before a
choice can reference pulls from that same Attempt. Missing metadata remains an
`unknown` declaration without pull links. Current item or version revocation
removes the identity from report records and denominators.

An association means the same identity was pulled in the same Attempt, not that
the choice caused it or occurred before the pull. Rejection can coexist with a
pull; no final winning choice is inferred. Multiple declarations remain visible.
Choice, pulled-usage, feedback-declared-usage and Skill×Job pair denominators are
separate. Feedback declarations may lack accepted receipt provenance; only joined
receipts appear in `feedback_receipt_refs`. No declaration becomes verified quality.

The online A/B/C engineering acceptance and deliberately disabled default are
tracked in [the acceptance matrix](../../docs/SKILL_SUGGESTIONS.md). Real-model
acceptance is waived by user instruction; business effectiveness, token cost and
elapsed-time gains remain unverified. That waiver is not evidence of improvement.
Optional model recommendation, Pack promotion and wider-source suggestions are
outside the current slice. Existing Hub replay and `job_usage_ledger` retain
execution/cost authority; this report does not allocate their totals to Skills.
