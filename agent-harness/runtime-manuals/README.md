# Runtime manual catalog

`catalog.json` is the canonical, machine-readable source for the offline tool manuals required by the 13 official runtime images. It is deliberately expanded: every image contains its own complete `entries` array, including tools inherited from `deepsonar-base`. Consumers must not resolve an image entry through a base-image reference.

## Delivery contract

The build materializer filters the canonical catalog against the final tool manifest and writes this self-contained layout into each image:

```text
/opt/deepsonar/manuals/index.json
/opt/deepsonar/manuals/INDEX.md
/opt/deepsonar/manuals/tools/<entry-id>.md
```

The image-local `index.json` is the Agent lookup surface and `INDEX.md` is its readable index. `tool-manifest.json` carries the manual contract, path, version, entry count, and SHA-256. The `self_contained: true` flag means the image's entries already include inherited base tools; `inherited_from` is provenance only. The build removes the canonical source catalog after materialization.

## Entry contract

Every entry has:

- `image_key`, `id`, `kind`, `agent_visible`, and `implementation_only`;
- a pinned or explicitly unresolved `version` and exact `version_source`;
- command names or an empty command list for libraries and implementation dependencies;
- usage scenario, selection basis, prerequisites, minimal invocation, and common parameters;
- output interpretation, composition flow, evidence retention, and version/side-effect/cleanup limits;
- all five failure classes: `normal_empty`, `model_correctable`, `transient_retryable`, `missing_condition`, and `permanent`;
- an honest `verification_status`. This catalog was generated from source manifests and wrapper code without pulling, building, or running Docker images, so it does not claim runtime execution succeeded.

`implementation_only: true` entries document package, build-stage, or installer dependencies that must be visible to maintainers for provenance but are not Agent commands in the final image.

## Sources and regeneration

The generator reads the checked-in runtime contracts and wrapper inventory listed in `catalog.json.source_contracts`. From the repository root run:

```bash
node agent-harness/runtime-manuals/generate-catalog.mjs
node -e "const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync('agent-harness/runtime-manuals/catalog.json','utf8')); if(c.images.length!==13||c.images.some(i=>!i.self_contained||i.entries.some(e=>e.image_key!==i.image_key))) process.exit(1); console.log(c.totals)"
```

When a Dockerfile adds or removes a command, wrapper, package, version, or capability entrypoint, update the generator and regenerate the catalog in the same change. A source entry whose package version is only `snapshot` or `dpkg` is intentionally marked as unresolved in the entry text; the image acceptance check should reject that state once an exact runtime version is available.
