# Changelog

Release entries are maintained from verified tag and repository changes. The immutable `vX.Y.Z` Git tag is the product release version. Root and workspace package versions remain private internal package metadata (`0.1.11`) and are not release identifiers.

## [Unreleased]

Changes intended for the next release go here before a release section is dated and tagged.

## [0.1.20] - 2026-08-08

### Added

- Governed runtime adapters now execute Claude Code, Codex, and OpenCode through a shared capability contract with frozen Job snapshots, normalized structured events, control MCP enforcement, and fail-closed readiness checks.
- Running local-docker Jobs now expose an authenticated, permission-gated PTY terminal beside the live event stream, with bounded traffic, resize support, audit metadata, and automatic sandbox cleanup.

### Changed

- Official runtime image selection now defaults to the Aliyun ACR channel, while jobs continue to freeze governed immutable image digests.
- Production deployment guidance and runtime configuration now reflect the current provider, gateway, object-storage, and image-channel behavior.
- GitHub Releases now publish the exact validated version section from this changelog and fail before image builds when tag or compare-link metadata is inconsistent.
- Runtime image size budgets now account for the governed Codex and OpenCode native payloads while retaining explicit CI-enforced limits for base, audit, and Kali images.

### Fixed

- Hardened runtime control, task observability, semantic event fixtures, fake-mode semantic output, agent completion idempotence, and isolated Agent CLI home directories.
- Canvas viewports now re-fit after durable graph additions or removals without timer races, while preserving trace and focused-node behavior.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.20` tag. Runtime image tags omit the `v` prefix; deployment can instead consume the published digest registry.
- The release workflow updates the bundled runtime registry and `deploy/.env.example` after the image catalog passes validation.

### Runtime Images

- The release workflow publishes and records the six official multi-architecture runtime image catalogs with inspected immutable digests and channel evidence.

## [0.1.19] - 2026-08-07

### Added

- Provider account settings and production deployment alignment were added.

### Changed

- Runtime image metadata and deployment image tags were synchronized for the release.

### Deployment / Upgrade Notes

- Product version is the immutable `v0.1.19` tag; image tags use `0.1.19` without the `v` prefix.

### Runtime Images

- The six-image runtime registry was published with multi-architecture digest metadata and release assets.

### Fixed

- CI skipped duplicate runtime-image smoke tests where the release pipeline already covered the same checks.

## [0.1.18] - 2026-08-07

### Fixed

- Restored the OpenHarmony vendored repository launcher checksum required by the runtime image build.

### Runtime Images

- The bundled runtime registry was synchronized for the `v0.1.18` release.

[0.1.20]: https://github.com/SummerSec/DeepSonar/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/SummerSec/DeepSonar/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/SummerSec/DeepSonar/compare/v0.1.17...v0.1.18
