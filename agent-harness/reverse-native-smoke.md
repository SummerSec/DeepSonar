# Real native reverse image validation

Use this same entry point on a fresh CI image and on a release image pinned by digest:

```sh
node agent-harness/reverse-native-smoke.mjs \
  --image deepsonar-reverse:local \
  --arch amd64 \
  --evidence-dir /tmp/reverse-evidence-amd64
node --test agent-harness/test-reverse-native-smoke.mjs
```

For arm64 use a native arm64 Linux runner and `--arch arm64`. Host Node architecture, Docker daemon architecture, inspected image architecture and container Node architecture must agree. A QEMU run or scratch toolchain result cannot satisfy this gate. The command neither builds nor pushes an image and never makes registry changes. It requires a fresh evidence directory.

Host prerequisites: Linux, Node, a working Docker daemon, `gcc`, and `x86_64-w64-mingw32-gcc`. On Ubuntu, install `gcc gcc-mingw-w64-x86-64`. Compiler tools are host-only. `compileSamples` builds native ELF and `.so` plus a Windows x64 PE from the public fixture, twice with identical paths and deterministic timestamp/build-id/prefix-map flags, and checks exact byte equality. Reproducibility is per recorded compiler version; hashes need not match a different compiler or native ELF architecture. The PE is only statically analyzed; it is never executed.

The Docker container uses the shipped `GHIDRA_HEADLESS_MAXMEM=1536m`, 4096 MiB memory with no extra swap, two CPUs, 256 PIDs, network `none`, no capabilities and `no-new-privileges`. Fixture/harness input is mounted read-only. The REA dependency closure is isolated in `agent-harness/rea-runtime/package-lock.json` and installed with `npm ci --omit=dev --ignore-scripts`; the root tarball bytes and lockfile SRI are separately checked. Each REA query has a 600-second deadline; the complete suite has a one-hour outer ceiling.

The suite checks the pinned environment and scoped doctor, then validates actual REA Evidence with schemas imported from the installed 6.4.0 package. ELF tests cover analyze, exact repeat with snapshot, different-query function dossier with that snapshot, procedure search, decompile, instructions, nonempty xrefs, bounded native value trace and a native view projected from the function Evidence. `.so` and PE each require nonempty analyze and function dossier/pseudocode/assembly results. Evidence hashes and concrete upstream Ghidra 12.1.4 identity must match; static text checks are not enough.

Cancellation waits until the owned headless Ghidra JVM is observed and its own log reports binary memory/code analysis has started (Java version/LaunchSupport probes do not count), sends SIGTERM to REA, requires a structured `cancelled` outcome and verifies no residual REA/Ghidra/Java/decompiler process or any live identity-matched owned descendant, regardless of executable name. It tracks descendants by PID and process-start identity, including observed detached groups. Forced cleanup terminates all tracked survivors on failure and makes the test fail; successful cancellation cannot be manufactured by a forced cleanup. The disposable container is forcibly removed and its absence checked at the end.

Memory is the actual kernel cgroup high-water counter (`memory.peak` on v2, `memory.max_usage_in_bytes` on v1), including page cache. Per-query values are cumulative for that container, not per-process RSS or a claim of an independently reset per-query peak. An unavailable counter fails closed. Raw process and memory records are retained. Image size comes from a real `docker save` of the immutable image ID streamed through gzip level 6 with no filename/timestamp; its actual compressed byte count and SHA-256 must stay under the provisional 2800 MiB ceiling. No component-size estimate can pass this check.

`measurements.json` records source revision/dirty state, exact image reference, immutable Docker image ID, available manifest digest, platform, sample/compiler hashes, query timings, separate Docker container creation/start time (excluding registry pull/network), cancellation time and pass booleans in `checks`. A fresh local image may have no registry manifest digest; the image ID is kept separately and is never mislabeled a manifest digest. Release invocations must use a digest reference. Only `passed: true`, `status: "passed"` and all checks true count as passed native evidence. Failure retains available raw stdout/stderr, query records, image/container inspection, sample bytes, process snapshots and a false aggregate. A failure before Docker exists records the blocker without claiming any OCI/native measurements.

## Missing Linux arm64 decompiler in pinned Ghidra PUBLIC

The SHA-256-verified `ghidra_12.1.4_PUBLIC_20260921.zip` includes prebuilt `linux_x86_64/decompile`, but no `linux_arm_64/decompile`. It includes the complete standalone Decompiler C++ source and Makefile. This matches the pinned upstream [Getting Started](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/GhidraDocs/GettingStarted.md#building-native-components) supported/prebuilt distinction.

`reverse-ghidra-native.sh` uses amd64's verified prebuilt binary. On an architecture-matched arm64 builder it builds only the headless native decompiler from that bundled source with `make -j2 ghidra_opt ARCH_TYPE= OSDIR=linux_arm_64 CXX='g++ -std=c++11'`, deterministic source-date/prefix-map/build-id settings, and checks the resulting ELF64 AArch64 machine. Explicit `ARCH_TYPE=` is required because the bundled standalone [Makefile](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/Ghidra/Features/Decompiler/src/decompile/cpp/Makefile) otherwise chooses `-m32` for non-x86_64 Linux. No wrapper, Gradle download, separate unpinned source tree or emulation fallback is used. Builder tools/objects stay outside the final runtime image. Native binary hash, zip hash, compiler and method are retained in provenance and checked by preflight. This supplies the native decompiler used by REA; it does not claim native debugger/demangler coverage.
