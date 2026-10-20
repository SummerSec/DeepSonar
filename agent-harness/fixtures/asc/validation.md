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
`a3400495879884955fe3a36fb8075d1f00113da831628a403d7aa699524a94e4`).
The reusable matrix writes equivalent evidence for image executions.

## Remaining validation

Final mobile images and arm64 execution require their own complete acceptance
run. Host tests, a dedicated ASC test container, and QEMU execution must not be
described as native dual-architecture final-image validation. No speed/RSS
benchmark or device/application execution was performed.
