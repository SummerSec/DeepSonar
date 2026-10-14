# Official runtime-image registry contract (Issue #70, Slices A+B+C)

> **Status: as-built (2026-10-14); v0.5.5 is pending its first successful tag-triggered Release (the v0.5.4 Release failed to publish Reverse to ACR / Docker Hub).**
> Index: [`README.md`](README.md). Release procedure:
> [`RELEASE_RUNTIME_IMAGES.md`](RELEASE_RUNTIME_IMAGES.md).

Slices A+B define the catalog trust boundary and the release evidence that
feeds it. Slice C adds a Scheduler-owned global channel selector and makes
resolution and Job snapshots consume that channel's immutable reference. A
missing reference on the selected channel is a hard failure. During real image
preparation, a transient pull transport error (such as timeout/EOF/OSS) may
retry another channel reference only when the catalog already carries inspect
evidence for the same canonical digest; the resulting local image is checked
against that frozen digest. This transport fallback does not change the global
channel, selected version, or historical Job snapshot. A missing digest or
unverified/different-digest reference cannot use this fallback and fails closed.

## v2 shape

The payload uses `schema: "deepsonar.registry/v2"` (or
`schema_version: 2`) and keeps one canonical multi-platform record per product
version; unselected historical versions may remain. Top-level
`platform_version` is the GitHub Release / scheduler / web / admission tag
and is independent of each product's `versions[].version`.
`min_runtime_image` is the platform floor (`version` plus optional
`by_image_key` overrides). Official selected versions below that floor fail
closed with `RUNTIME_IMAGE_BELOW_PLATFORM_MIN` before a task or Job snapshot
is frozen. Catalog reuse requires an exact canonical digest match, or proof
that the immutable candidate index contains exactly the tested runnable
platform manifest digests. A source-cache/fingerprint hit alone does not prove
reuse and must never select the first catalog row without content comparison.
For Chrome and ClickHouse Audit/Test/Fuzz with both architecture caches hit,
the release resolves each tested wrapper/index to one runnable manifest for
its platform, then compares the exact `linux/amd64` / `linux/arm64` manifest
digest map against the immutable catalog candidate. Attestation descriptors
are excluded from this payload comparison; missing, duplicate, ambiguous, or
unexpected runnable platforms and inspect/parse errors fail closed. Equal
payloads retain the candidate version and canonical digest, even when wrapper
or attestation metadata differs. A payload mismatch or no catalog match uses
the tested cached children to assemble a new index, publish all configured
channels, and collect fresh inspect evidence. The final selected catalog
digest must contain the tested child manifests. Other callers retain the
exact-canonical-digest reuse path. Reuse does not invent a product version equal
to `platform_version`.

The independent final gate, `agent-harness/check-runtime-catalog-platforms.mjs`,
requires all 12 native-smoke artifacts (these six products times both target
platforms). It uses the Scheduler's exact latest-version ordering to resolve
the selected row for each channel/platform; a matching historical row alone
does not prove which payload the Scheduler will select. Within each available
channel, amd64 and arm64 must select the same canonical two-platform row;
split-platform selection explicitly fails closed. This gate validates catalog
bulk/latest selection only and never overrides existing frozen/pinned Job
digests. Unselected historical rows remain valid. The gate resolves the tested runnable manifests and
re-inspects the generated catalog's selected immutable GHCR index and every
available optional-channel index. Missing or ambiguous selections, a stale
selected payload on any available channel, missing/duplicate artifacts, and
inspect/parse failures fail the release before asset upload or bundled
writeback.
Cache-hit flags, version labels, and descriptor-provided digests are not proof.
This catalog correction leaves runtime-image inputs and fingerprints unchanged.
Other v0.5.4 changes, including #718 shared manual inputs, may still require
rebuilds; cache reuse is determined by the actual fingerprint and smoke gates.

```json
{
  "schema": "deepsonar.registry/v2",
  "schema_version": 2,
  "platform_version": "0.2.10",
  "min_runtime_image": { "version": "0.2.7", "by_image_key": {} }
}
```

Each product version uses one canonical multi-platform record:

```json
{
  "version": "0.1.6",
  "digest": "sha256:<64 lower-case hex>",
  "platforms": ["linux/amd64", "linux/arm64"],
  "size_bytes": 215224931,
  "registry_refs": {
    "github": "ghcr.io/summersec/deepsonar-base@sha256:<same digest>",
    "dockerhub": "docker.io/sumsec/deepsonar@sha256:<same digest>"
  },
  "registry_evidence": {
    "github": {
      "available": true,
      "ref": "ghcr.io/summersec/deepsonar-base@sha256:<same digest>",
      "inspect_digest": "sha256:<same digest>",
      "provenance": "build-push+inspect"
    },
    "dockerhub": {
      "available": false,
      "provenance": "unavailable",
      "reason": "credentials_missing"
    },
    "aliyun-acr": {
      "available": false,
      "provenance": "unavailable",
      "reason": "credentials_missing"
    }
  }
}
```

`registry_refs` keys are exactly `github`, `dockerhub`, and `aliyun-acr`.
Omitting a key means that channel is unavailable. `registry_evidence` is
required and must contain exactly those three channel entries; an available
entry must match a present `registry_refs` value and the canonical digest, while
an unavailable optional entry must contain only `available:false`,
`provenance:"unavailable"`, and a non-empty reason. The release baseline
requires GitHub evidence to be available and inspected. Every present reference
is an immutable OCI digest reference whose normalized digest exactly equals the
canonical `digest`; normalized references may not be duplicated. Metadata
provenance (`remote`, `bundled`, or `upload`) is a separate top-level field and
is not an OCI channel. Scheduler-owned `fallback`, `error`, and `checked_at`
fields are added after parsing and are not accepted from a catalog upload.
Available provenance is fixed to `build-push+inspect` for GitHub and
`cross-registry-copy+inspect` for Docker Hub/ACR. Unavailable reasons are
bounded single-line tokens (1-128 ASCII characters).

## Release evidence and channel availability

The `v*` release workflow publishes in the fixed order ACR (when configured),
GHCR, then Docker Hub (when configured). Cross-registry copies use bounded
exponential retries. A configured-channel failure sets
`CHANNEL_PUBLISH_FAILED`; `record-runtime-image-digest.mjs` then refuses to
write a descriptor, so the release cannot generate or upload a partial
catalog. Docker Hub and ACR credentials are optional: an unavailable channel
is represented by `registry_records.<channel>` with `available:false`,
`provenance:"unavailable"`, and a reason. No placeholder host or canonical
digest is emitted for an unavailable channel.

For every available channel the recorder runs
`docker buildx imagetools inspect` against the destination reference and
requires its human-readable `Digest:` to equal the build canonical digest.
Only that inspected digest reference is emitted. The recorder also records
the GHCR platform descriptor/size evidence used by the size gate. The release
job requires one descriptor for each of the 14 official products and emits
one canonical v2 record per product version (all platforms in a single
`versions[]` entry). It may preserve historical versions on a digest hit; it
validates the result, uploads
`runtime-image-registry-v2.json` as a release asset, and updates the bundled
v2 fallback. The parser requires inspected GitHub evidence for a public v2
catalog; the Scheduler's apply path also defensively demotes a stale legacy
GitHub promotion if an internally supplied channel-only item has no
`image_ref`, rather than selecting another channel.

Current release gate: `deepsonar-reverse` is a required product, and
`release.yml` wires its publisher (#723): `reverse-image-builds` builds and
gates native amd64/arm64 children (REA/Ghidra smoke plus a real OpenSandbox
Job), and `reverse-images` assembles the canonical index, publishes and
inspects every configured channel, and writes `reverse.json`; the final
Release job depends on it. v0.5.5 succeeded and wrote reverse `0.5.5`
(`sha256:45b538274f513933135bd895d7350d51c7c0a557e5784a77e74b4be9b82820b8`)
back to the bundled registry with three-channel inspect evidence. Wiring alone
is still not evidence for future releases; the catalog must not silently omit
the product or use fabricated descriptors.

The pure validator lives in
`apps/scheduler/src/runtime-image-registry-contract.ts`. Its OCI parser rejects
URLs, userinfo, ports, tag-only references, query/fragment/escape syntax,
traversal or empty path segments, uppercase/ambiguous hosts, and malformed
sha256 digests. GitHub and Docker Hub use the server-owned canonical
`ghcr.io/summersec` and `docker.io/sumsec` policy. The built-in ACR policy
pins the exact currently published official endpoint
`crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec`; other
ACR endpoints require a server-owned policy and are never self-authorized by
Agent, Hub, task, or catalog content.

## v1 compatibility

`deepsonar.registry/v1` (and numeric `schema_version: 1`) remains accepted.
Each legacy `image_ref` is validated and normalized into a one-entry
`registry_refs` map (the existing GHCR catalog therefore becomes
`{ "github": "..." }`) while preserving `image_ref` for existing catalog,
apply, and resolve paths. The v1 generator always emits the fixed GHCR
projection even when ACR credentials are present; per-channel ACR/Docker Hub
references belong to the v2 publisher. Unknown schema versions fail closed.

For compatibility with the legacy v1 shape, the validator permits the
same normalized ref to appear more than once for one image when every duplicate
declares a non-empty, mutually disjoint platform set (the historical
one-platform-per-version multi-arch alias). Same-platform, missing-platform,
cross-image, and all v2 duplicates fail closed. A v2 publisher must merge those
platforms into one canonical version.

## Slice C channel selector

The singleton `global_settings.runtime_registry_channel` defaults to
`aliyun-acr` in the current database baseline and is changed only through the
authenticated Scheduler API:

| Method | Path | Scope | Contract |
| --- | --- | --- | --- |
| GET | `/runtime-images/registry` | `images:read` | Returns the parsed catalog plus `selected_channel`. |
| PATCH | `/runtime-images/registry/channel` | `images:manage` | Strict body `{ "channel": "github"\|"dockerhub"\|"aliyun-acr" }`; extra fields, query overrides, and environment overrides are rejected. Project-scoped tokens receive `403 PROJECT_SCOPE_FORBIDDEN`. Missing images or an in-flight preparation return `202 preparing/saved:false` plus the current `pull-status`; the previous channel stays active until a later retry persists. |

The channel update is audited as
`runtime_image.registry_channel_update`. Job creation reads the selector under
the transaction lock and freezes the selected channel and immutable digest/ref
in `agent_snapshot_json`; changing the selector never rewrites existing Job
snapshots.

## Slice C boundary

The Web UI exposes the platform-global `selected_channel` as a fixed
`github`/`dockerhub`/`aliyun-acr` selector on the marketplace page. It keeps
that source choice separate from the CPU architecture/platform filter,
requires `images:manage` for mutation, surfaces loading/403/mutation states,
keeps the selector on the pending target while preparation is in flight, and
refreshes the registry metadata and marketplace rows after a successful
switch. An in-flight pull is shown on the shared progress panel rather than as
a hard channel-switch failure. It does not accept arbitrary registry URLs or
source input. Together with exact-channel pull and immutable Job snapshots,
this completes Issue #70.

## tools_manifest_sha256 口径（#629 / #633 / #636）

官方 catalog 当前登记的是镜像内嵌 `manifest.sha256`（与 `sha256sum` 文件字节哈希可能不同）。
Scheduler / OpenSandbox provision **接受任一匹配**（双口径）。不要靠手工
`UPDATE runtime_image_versions.tools_manifest_sha256` 做长期缓解——registry sync 的
`COALESCE(EXCLUDED, existing)` 会在远端 catalog 带非空值时覆盖。部署后用
`GET /runtime-images/contract-selftest` 核对；详见
[`RUNTIME_IMAGE_CONTRACT_DEPLOY.md`](RUNTIME_IMAGE_CONTRACT_DEPLOY.md)。
可选的显式 `tools_manifest_sha256_scope` 字段留作后续发布管线统一，本切片不改 schema。

