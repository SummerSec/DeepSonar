# Official runtime-image registry contract (Issue #70, Slices A+B+C)

Slices A+B define the catalog trust boundary and the release evidence that
feeds it. Slice C adds a Scheduler-owned global channel selector and makes
pull/resolution consume that channel exactly. A missing reference on the
selected channel is a hard failure; the Scheduler never substitutes a Docker
Hub, ACR, or GitHub reference from another channel.

## v2 shape

The payload uses `schema: "deepsonar.registry/v2"` (or
`schema_version: 2`) and keeps one canonical version record:

```json
{
  "version": "0.1.6",
  "digest": "sha256:<64 lower-case hex>",
  "platforms": ["linux/amd64", "linux/arm64"],
  "size_bytes": 215224931,
  "registry_refs": {
    "github": "ghcr.io/summersec/deepsonar-base@sha256:<same digest>",
    "dockerhub": "docker.io/summersec/deepsonar-base@sha256:<same digest>"
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
job merges six descriptors into one v2 version per image (all platforms in a
single `versions[]` entry), validates the result, uploads
`runtime-image-registry-v2.json` as a release asset, and updates the bundled
v2 fallback. The parser requires inspected GitHub evidence for a public v2
catalog; the Scheduler's apply path also defensively demotes a stale legacy
GitHub promotion if an internally supplied channel-only item has no
`image_ref`, rather than selecting another channel.

The pure validator lives in
`apps/scheduler/src/runtime-image-registry-contract.ts`. Its OCI parser rejects
URLs, userinfo, ports, tag-only references, query/fragment/escape syntax,
traversal or empty path segments, uppercase/ambiguous hosts, and malformed
sha256 digests. GitHub and Docker Hub use the server-owned canonical
`ghcr.io/summersec` and `docker.io/summersec` policy. The built-in ACR policy
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

The singleton `global_settings.runtime_registry_channel` defaults to `github`
and is changed only through the authenticated Scheduler API:

| Method | Path | Scope | Contract |
| --- | --- | --- | --- |
| GET | `/runtime-images/registry` | `images:read` | Returns the parsed catalog plus `selected_channel`. |
| PATCH | `/runtime-images/registry/channel` | `images:manage` | Strict body `{ "channel": "github"\|"dockerhub"\|"aliyun-acr" }`; extra fields, query overrides, and environment overrides are rejected. Project-scoped tokens receive `403 PROJECT_SCOPE_FORBIDDEN`. |

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
and refreshes the registry metadata and marketplace rows after a successful
switch. It does not accept arbitrary registry URLs or source input. Together
with exact-channel pull and immutable Job snapshots, this completes Issue #70.
