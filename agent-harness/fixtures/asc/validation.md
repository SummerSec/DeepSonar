# ASC fixture validation — 2026-10-20

Scope: synthetic, unsigned 2,422-byte APK built from this directory's original
sources. This establishes behavior on this fixture, not general APK compatibility
or a performance improvement.

- Fixture SHA-256: `4f34e661c45a0470505d19d92257a9abfe5e5002b3a3adc5eb1d1de6d9c5adac`.
- Rust tag `v0.1.1`, commit `236dd096669c99eb30f6e1af0b24e668eff55dd5`.
- Upstream Cargo package declares `0.1.0`; the wrapper reports the pinned source tag `v0.1.1` and full commit, not that stale package version.
- radguard gitlink `290de20c925c4a2c7642b1a63c9997185a06e130`.
- Build: Rust 1.94.0 bookworm, `cargo build --release --locked --no-default-features`.
- Python comparison: `droidasc==0.1.1.post1`, androguard 4.1.4, Python 3.12.
- Wrapper: this change's `deploy/mobile-asc.sh`, pointing to the compiled Rust executable.
- Fixture rebuilt twice with pinned apktool 3.0.3 and Java 21; identical SHA-256.
- Binary XML signature and both DEX signatures checked independently.

## Host execution

The acceptance script's embedded Python matrix was run on an x86_64 host with
paths redirected to the real binaries and fixture. **59 subprocess invocations
passed**, including both Rust entrypoints and the explicit Python entrypoint.
This host execution was not network-isolated and is not final mobile image
validation. No fake CLI was used.

Coverage: manifest; Primary and Secondary classes; string/type/method/field
references; exact and fuzzy declaring-class filters; DEX2 string lookup; `-o`
contents against stdout; no-match output; missing/empty class; corrupt APK;
unknown option; source version identity; successful help without MCP; rejected MCP command; `--threads 2` and `--threads=2` compatibility.

The decoded manifests have equal XML element/attribute semantics. All reference
sets match after sorting lines. Single-class pseudocode matched on this fixture;
that does not promise byte-identical pseudocode on other inputs.

| Observation | Rust through adapter | Python ASC |
| --- | --- | --- |
| Manifest | Exit 0; XML declaration and multiline attributes | Exit 0; different XML whitespace |
| Fuzzy cross-DEX references | Exit 0; matching set | Exit 0; DEX result order may differ |
| No matching string | Exit 0; empty stdout and empty output file | Same |
| Missing class / empty class | Exit 1 | Exit 1 |
| Corrupt ZIP, all three query commands | Exit 2; explicit container error | Exit 1; ZIP/EOCD error |
| Unknown CLI option | Exit 1 | Exit 2 |

The unwrapped upstream Rust binary was also run against the corrupt ZIP:
`findrefs broken.apk string token` returned **0 with empty output**. The adapter's
ZIP validation converts this misleading success to a failure; it does not
silently switch implementations. Error text and exact exit values intentionally
remain different from Python.

Raw host evidence was retained at `/tmp/asc-host-results/results.json` with
stdout, stderr, exit status and output hashes for every case (report SHA-256
`0e93524c63037d108bf1e2ade4a1205b8e254a69264fe2109b221668781871c0`).
The reusable matrix writes equivalent evidence for image executions.

## Dedicated offline ASC container

The unmodified image acceptance entrypoint also passed all **59 invocations**
using `docker --network none` on linux/amd64:

```bash
node agent-harness/test-asc-apk.mjs deepsonar-asc-test:amd64 linux/amd64 /tmp/asc-offline-results
```

This is a dedicated test image, **not the final mobile image**. It was built
offline from the already pulled Python 3.12 bookworm image
(`sha256:5560e9ab8709f459489e5b8aa696eda8a07ef821e14bb122be62d91234bfa98b`),
the compiled Rust binary, this change's adapter, the real host unzip executable,
and the already installed Python venv dependencies. Its local image ID is
`sha256:20aa6f97d282918d3fc60b4d0982140fb23edea43ec77f54d95460fd47c3b093`.
It was not pushed to any registry.

Evidence is retained under `/tmp/asc-offline-results`, including image inspect,
invocation metadata, output files and the complete JSON report (SHA-256
`2e284ed697758a80f987703134a89b467644a3adb5641b0cb824e9db37aa8b12`).
The report records actual Python package versions and x86_64 execution.
Earlier attempts to install dependencies inside the test build could not resolve
the configured network/proxy; they were stopped. Copying the host's already
installed dependencies allowed isolated execution without claiming that the
final mobile Dockerfile built successfully.

## Remaining validation

Final mobile images and arm64 execution require their own complete acceptance
run. Host tests, a dedicated ASC test container, and QEMU execution must not be
described as native dual-architecture final-image validation. No speed/RSS
benchmark or device/application execution was performed.

## Read-only upstream license review

The fixed radguard revision `290de20c925c4a2c7642b1a63c9997185a06e130`
was checked against its complete six-commit history (not a shallow checkout),
root and nested paths, README/docs/source headers, Cargo package metadata,
annotated tags v0.1.0–v0.1.3, and release packaging workflow. No LICENSE,
COPYING, NOTICE, SPDX statement, `license`/`license-file`, or other express
permission covering radguard was found. The v0.1.3 public release page only
links its generated changelog and does not add a license grant. Release
attachments were not separately inspected.

The parent rust_ASC root LICENSE, Cargo.toml and README say Apache-2.0, but
no text explicitly covering the separately versioned radguard submodule was
found. This review does not establish distribution authorization. Clarification
covering the pinned revision remains required before distribution; no upstream
message was sent.

## CI dependency resolution correction

The first final-head main CI (`39395048111`) exposed an existing base/audit
build issue: jq `1.6-2.1+deb12u2` requires exactly matching libjq1, while APT
selected security candidate `deb12u3` for the unpinned library. Debian bookworm's
package index still contains both jq and libjq1 `deb12u2`. The Dockerfile now
pins libjq1 to the existing `JQ_VERSION`, with a consistency regression check.
No tool version or #747 deployment upgrade contract was changed.
