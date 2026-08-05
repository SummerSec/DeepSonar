# Official runtime-image registry contract (Issue #70, Slice A)

Slice A defines the catalog trust boundary. It does not implement channel
selection or channel-aware pull/resolution, and it does not change the
database schema. The legacy/current Scheduler consumer projects only the
GitHub reference (`registry_refs.github`) and explicitly skips a version with
no GitHub projection; it never replaces that unavailable version with a
Docker Hub or ACR reference.

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
  }
}
```

`registry_refs` keys are exactly `github`, `dockerhub`, and `aliyun-acr`.
Omitting a key means that channel is unavailable. Every present reference is
an immutable OCI digest reference whose normalized digest exactly equals the
canonical `digest`; normalized references may not be duplicated. Metadata
provenance (`remote`, `bundled`, or `upload`) is a separate top-level field and
is not an OCI channel.

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

## Slice A boundary

This slice intentionally does not implement release destination publication or
digest verification, metadata mirroring, DB/admin channel settings,
channel-aware selection/pull/resolution, or Web UI changes. Those belong to the
later #70 slices; Issue #70 remains open.
