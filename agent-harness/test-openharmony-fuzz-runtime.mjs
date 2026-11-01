#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const [image, flag, platform, ...extra] = process.argv.slice(2);
if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]*$/.test(image) || flag !== "--platform"
  || !/^linux\/(amd64|arm64)$/.test(platform ?? "") || extra.length) {
  throw new Error("usage: node test-openharmony-fuzz-runtime.mjs IMAGE --platform linux/amd64|linux/arm64");
}
const arch = platform.split("/")[1];
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux"
  || process.arch !== { amd64: "x64", arm64: "arm64" }[arch]) {
  throw new Error("This probe requires GitHub Actions on a matching native Linux runner; QEMU is not acceptance.");
}
function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: status=${result.status}, signal=${result.signal ?? "none"}`, { cause: result.error });
  }
  return result.stdout.trim();
}
const daemonArch = docker(["info", "--format", "{{.Architecture}}"]);
if (!{ amd64: ["x86_64", "amd64"], arm64: ["aarch64", "arm64"] }[arch].includes(daemonArch)) {
  throw new Error(`Docker daemon architecture ${daemonArch} does not match ${platform}`);
}
// Print only identity/platform/user metadata, never the image's environment.
const [imageId, imageOs, imageArch, imageUser, ...unexpected] = docker([
  "image", "inspect", image, "--format", "{{.Id}} {{.Os}} {{.Architecture}} {{.Config.User}}",
]).split(/\s+/);
if (unexpected.length || imageOs !== "linux" || imageArch !== arch
  || !/^sha256:[0-9a-f]{64}$/.test(imageId ?? "")
  || !["deepsonar", "deepsonar:deepsonar"].includes(imageUser)) {
  throw new Error("Image must be the native Linux target with default deepsonar user and immutable local image ID");
}
console.log(JSON.stringify({ image, imageId, platform, hostArch: process.arch, daemonArch }));

const script = String.raw`set -euo pipefail
[[ "$(id -un)" == deepsonar && "$(id -u)" != 0 ]]
expected="$1"
case "$expected" in
  amd64) native=x86_64; machine='Advanced Micro Devices X86-64' ;;
  arm64) native=aarch64; machine=AArch64 ;;
  *) exit 2 ;;
esac
[[ "$(uname -m)" == "$native" ]]
uname -a
printf 'ASLR (read only): '; cat /proc/sys/kernel/randomize_va_space
if [[ -r /proc/sys/vm/mmap_rnd_bits ]]; then
  printf 'mmap_rnd_bits='; cat /proc/sys/vm/mmap_rnd_bits
fi
work="$(mktemp -d /tmp/deepsonar-oh-fuzz-XXXXXX)"
cleanup() {
  local status=$? resolved
  resolved="$(realpath -- "$work")"
  if [[ "$resolved" != "$work" || ! "$resolved" =~ ^/tmp/deepsonar-oh-fuzz-[[:alnum:]]{6}$ ]]; then
    echo 'Refusing cleanup of an unexpected temporary path' >&2; exit 1
  fi
  rm -rf -- "$resolved"
  exit "$status"
}
trap cleanup EXIT
# libFuzzer crash artifacts also stay inside this owned temporary directory.
cd "$work"
export ASAN_OPTIONS=detect_leaks=0:halt_on_error=1:abort_on_error=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
failures=0
clang --version > "$work/clang-version"; cat "$work/clang-version"
clang++ --version > "$work/clangxx-version"; cat "$work/clangxx-version"
afl-clang-fast --version > "$work/afl-c-version"; cat "$work/afl-c-version"
afl-clang-fast++ --version > "$work/afl-cxx-version"; cat "$work/afl-cxx-version"
for version in clang-version clangxx-version afl-c-version afl-cxx-version; do
  grep -Eq 'clang version 19\.' "$work/$version"
done
llvm-symbolizer --version
dpkg-query -W clang-19 libclang-rt-19-dev llvm-19
triple="$(clang -print-target-triple)"
resource="$(clang -print-resource-dir)"
printf 'Clang target=%s resource-dir=%s\n' "$triple" "$resource"
[[ "$triple" == "$native-"* && "$resource" == /usr/lib/llvm-19/lib/clang/19* ]]
for compiler in clang++ afl-clang-fast++; do
  compiler_target="$("$compiler" -print-target-triple)"
  compiler_resource="$("$compiler" -print-resource-dir)"
  printf 'compiler=%s path=%s target=%s resource=%s\n' "$compiler" "$(command -v "$compiler")" "$compiler_target" "$compiler_resource"
  [[ "$compiler_target" == "$triple" && "$compiler_resource" == "$resource" ]]
done
for runtime in asan fuzzer fuzzer_interceptors ubsan_standalone; do
  archive="$resource/lib/linux/libclang_rt.$runtime-$native.a"
  printf 'compiler-rt archive=%s\n' "$archive"; test -s "$archive"
done
set +e
afl-fuzz -h > "$work/afl-version" 2>&1
afl_help_status=$?
set -e
printf 'afl-fuzz help status=%s\n' "$afl_help_status"; cat "$work/afl-version"
grep -Eq '4\.32c' "$work/afl-version"
printf 'AFL LLVM instrumentation=%s\n' "$AFL_LLVM_INSTRUMENT"
[[ "$AFL_LLVM_INSTRUMENT" == PCGUARD ]]
helper=/opt/deepsonar/bin/openharmony-fuzz-build.sh
test -x "$helper"

elf_check() {
  local binary="$1" engine="$2"
  readelf -h "$binary" > "$work/header"; cat "$work/header"
  grep -Eq 'Class:[[:space:]]+ELF64' "$work/header"
  grep -Eq 'Type:[[:space:]]+DYN' "$work/header"
  grep -Fq "$machine" "$work/header"
  readelf -d "$binary" > "$work/dynamic"
  grep -Eq 'FLAGS_1.*PIE' "$work/dynamic"
  readelf -Ws "$binary" > "$work/symbols"
  grep -Eq '[[:space:]]__asan_init($|[[:space:]])' "$work/symbols"
  if [[ "$engine" == libfuzzer ]]; then
    grep -Eq '[[:space:]]LLVMFuzzerRunDriver($|[[:space:]])' "$work/symbols"
  else
    grep -Eq '[[:space:]]__afl_area_ptr($|[[:space:]])' "$work/symbols"
    grep -Eq '[[:space:]]__sanitizer_cov_trace_pc_guard($|[[:space:]])' "$work/symbols"
  fi
  grep -E 'FLAGS_1.*PIE' "$work/dynamic"
  grep -E '[[:space:]](__asan_init|LLVMFuzzerRunDriver|__afl_area_ptr|__sanitizer_cov_trace_pc_guard)($|[[:space:]])' "$work/symbols"
  printf 'ELF/PIE/sanitizer/instrumentation symbols checked: %s\n' "$binary"
}
run_logged() {
  local label="$1"; shift
  set +e
  timeout --signal=TERM --kill-after=1s 8s "$@" > "$work/$label.log" 2>&1
  status=$?
  set -e
  printf 'launch=%s status=%s\n' "$label" "$status"
  cat "$work/$label.log"
}
# The original environment probe's C source and command, without altered flags.
printf 'int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n){(void)d;(void)n;return 0;}\n' \
  | clang -x c - -O1 -g -fno-omit-frame-pointer -fsanitize=fuzzer,address,undefined -o "$work/original-c"
printf 'extern "C" int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n){(void)d;(void)n;return 0;}\n' > "$work/empty.cc"
printf 'int main(void){return 0;}\n' > "$work/empty-afl.cc"
"$helper" --engine libfuzzer --source "$work/empty.cc" --output "$work/helper-lib"
AFL_DEBUG=1 "$helper" --engine afl --source "$work/empty-afl.cc" --output "$work/helper-afl" 2>&1 | tee "$work/afl-build.log"
# The shared coverage hook alone cannot distinguish PCGUARD from NATIVE mode.
grep -Fq -- '-fpass-plugin=/usr/local/lib/afl/SanitizerCoveragePCGUARD.so' "$work/afl-build.log"
elf_check "$work/original-c" libfuzzer
elf_check "$work/helper-lib" libfuzzer
elf_check "$work/helper-afl" afl
for path in original-c helper-lib helper-afl; do
  for ((launch=1; launch<=20; launch++)); do
    if [[ "$path" == helper-afl ]]; then
      run_logged "$path-$launch" env ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$work/$path"
    else
      run_logged "$path-$launch" env ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$work/$path" -runs=1
    fi
    if [[ "$status" != 0 ]]; then failures=$((failures+1)); fi
  done
done

cat > "$work/asan.cc" <<'CPP'
#include <cstddef>
#include <cstdlib>
#include <cstdio>
static int probe(const unsigned char *data, size_t n) {
  if (!n) return 0;
  volatile size_t length = 8;
  volatile unsigned char *p = static_cast<unsigned char *>(malloc(length));
  if (!p) return 0;
  p[length] = data[0];
  free(const_cast<unsigned char *>(p));
  return 0;
}
CPP
cat > "$work/ubsan.cc" <<'CPP'
#include <cstddef>
#include <climits>
#include <cstdio>
static int probe(const unsigned char *data, size_t n) {
  if (!n) return 0;
  volatile int value = INT_MAX;
  volatile int result = value + static_cast<int>(data[0]);
  return result;
}
CPP
cat > "$work/driver.inc" <<'CPP'
#ifdef AFL_DRIVER
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  FILE *input = fopen(argv[1], "rb");
  if (!input) return 2;
  unsigned char byte = 0;
  size_t n = fread(&byte, 1, 1, input);
  fclose(input);
  return probe(&byte, n);
}
#else
extern "C" int LLVMFuzzerTestOneInput(const unsigned char *data, size_t n) {
  return probe(data, n);
}
#endif
CPP
printf '\001' > "$work/one"
for kind in asan ubsan; do
  cat "$work/driver.inc" >> "$work/$kind.cc"
  for engine in libfuzzer afl; do
    binary="$work/$engine-$kind"
    if [[ "$engine" == afl ]]; then
      "$helper" --engine afl --source "$work/$kind.cc" --output "$binary" --cflags '-DAFL_DRIVER'
    else
      "$helper" --engine libfuzzer --source "$work/$kind.cc" --output "$binary"
    fi
    elf_check "$binary" "$engine"
    if [[ "$kind" == asan ]]; then
      signature='AddressSanitizer: heap-buffer-overflow'
    else
      signature='runtime error: signed integer overflow'
      readelf -Ws "$binary" > "$work/ubsan-symbols"
      grep -Eq '[[:space:]]__ubsan_handle_add_overflow' "$work/ubsan-symbols"
    fi
    # Replay one explicit byte, never run an unbounded fuzz campaign.
    run_logged "$engine-$kind" "$binary" "$work/one"
    if ((status == 0 || status == 124 || (status >= 128 && status != 134))) \
      || ! grep -Fq "$signature" "$work/$engine-$kind.log"; then
      echo "Missing specific sanitizer rejection: $engine/$kind" >&2
      failures=$((failures+1))
    fi
  done
done

cat > "$work/branches.cc" <<'CPP'
#include <cstdio>
__attribute__((noinline)) int branch_a() { return puts("branch-A"); }
__attribute__((noinline)) int branch_b() { return puts("branch-B"); }
int main() { return (getchar() == 'A' ? branch_a() : branch_b()) < 0; }
CPP
"$helper" --engine afl --source "$work/branches.cc" --output "$work/branches"
elf_check "$work/branches" afl
printf A > "$work/input-A"; printf B > "$work/input-B"
for branch in A B; do
  run_logged "showmap-$branch" bash -c \
    'afl-showmap -q -e -m none -t 5000 -o "$1" -- "$2" < "$3"' \
    bash "$work/map-$branch" "$work/branches" "$work/input-$branch"
  if [[ "$status" != 0 ]] || ! test -s "$work/map-$branch"; then
    echo "AFL coverage map missing/failed: $branch" >&2; failures=$((failures+1))
  else
    cat "$work/map-$branch"
  fi
done
if ! test -s "$work/map-A" || ! test -s "$work/map-B" || cmp -s "$work/map-A" "$work/map-B"; then
  echo 'AFL branch inputs did not yield two nonempty different coverage maps' >&2
  failures=$((failures+1))
fi
printf 'Fixed fresh launches: 20 original C + 20 helper libFuzzer + 20 helper AFL; failures=%s\n' "$failures"
[[ "$failures" == 0 ]]
`;
const name = `deepsonar-oh-fuzz-${randomUUID()}`;
try {
  docker([
    "run", "--rm", "--init", "--name", name, "--pull", "never", "--platform", platform,
    "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "4g", "--pids-limit", "256", "-i", imageId,
    "timeout", "--signal=TERM", "--kill-after=5s", "160s", "bash", "-s", "--", arch,
  ], { input: script, timeout: 180_000 });
} catch (error) {
  // A timed-out Docker client does not prove its container has exited.
  if (!/^deepsonar-oh-fuzz-[0-9a-f-]{36}$/.test(name)) throw error;
  const cleanup = spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 10_000 });
  if (cleanup.stdout) process.stdout.write(cleanup.stdout);
  if (cleanup.stderr) process.stderr.write(cleanup.stderr);
  throw error;
}
console.log(`Native OpenHarmony sanitizer regression passed: ${platform}, image=${imageId}`);
