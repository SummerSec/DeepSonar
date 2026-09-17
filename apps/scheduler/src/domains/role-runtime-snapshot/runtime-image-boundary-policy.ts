/**
 * Official specialty-image capability boundaries injected into Job AGENTS.md.
 * Keep markers stable — characterization tests lock the heading strings.
 *
 * Injection rule (withRuntimeTestToolchainPolicy):
 * - Runtime test toolchain block: role `test`, or `verify` when image is not deepsonar-base.
 * - Specialty image boundary: ANY role when resolved image_key is in SPECIALTY_RUNTIME_IMAGE_POLICIES
 *   (chrome-*, clickhouse-*, openharmony-*, mobile). Base / audit / kali alone do not get a specialty block.
 */

export const OPENHARMONY_HDC_POLICY = `### OpenHarmony hdc device protocol (Scheduler policy)

This Job uses deepsonar-openharmony-test. Dynamic device evidence must come from the pinned official OpenHarmony hdc (OpenHarmony Device Connector), the same way Chrome Test uses CDP.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json and confirm device.protocol is hdc. Use hdc for list targets, shell, file send/recv, install, hilog, fport, and hdc tconn host:port or a host-mapped device. USB privileges are out of scope.
- Do not install DevEco, a full SDK, HarmonyOS proprietary toolchains, nmap, or Kali process tools (gdb/strace) as a substitute device protocol.
- If hdc list targets is empty ([Empty]), submit structured inconclusive/needs_human evidence. Never invent device results from host narration, source comments, or build logs.`;

export const MOBILE_RUNTIME_POLICY = `### Mobile device protocols (Scheduler policy)

This Job uses deepsonar-mobile. Official image covers Android, iOS host tools, and OpenHarmony app/device protocol. Do not install MobSF, jadx-gui, Burp, IDA, Ghidra, DevEco, a full OpenHarmony SDK, third-party MCP servers, or decision scanners.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json before first use of jadx/droidasc/adb/frida/hdc and related wrappers.
- **Android.** Java/Kotlin APK/AAB work uses the pinned JADX CLI, apktool, bundletool, apkeep, androguard, droidasc (Droid ASC: on-demand getclass/getmanifest/findrefs; prefer for large-APK class lookup or cross-DEX xref without a full JADX index; use JADX for broader full decompile), and apkcheckpack (Agent-invoked packer/SDK fingerprint CLI; not a platform scan entry). Native .so / ELF work uses readelf/objdump/nm, radare2, LIEF, and mobile-so.sh inspect. Dynamic evidence must come from official adb (devices/shell/push|pull/install/forward/reverse) or a host-mapped device/emulator. Instrumentation uses Frida/Objection and /opt/deepsonar/frida-server. Do not install mitmproxy/Burp. Do not use droidasc --gui. Empty adb devices → needs_human / inconclusive. Never invent device, traffic, or native/OLLVM results from JADX, droidasc, or apkcheckpack.
- **iOS.** Linux host only: idevice_id / ideviceinstaller / plistutil / iproxy. No Xcode, Simulator, or class-dump. IPA static work is unzip + plistutil. Empty idevice_id → needs_human / inconclusive. Never invent device results from IPA unzip.
- **OpenHarmony.** HAP static work is unzip + pack.info / module.json. Device evidence must come from the pinned official hdc (same vendor bits as deepsonar-openharmony-test): list targets, shell, file send/recv, install, hilog, fport, tconn. Empty hdc list targets ([Empty]) → needs_human / inconclusive. Do not install DevEco or a full SDK as a substitute.`;

export const CHROME_TEST_RUNTIME_POLICY = `### Chrome CDP runtime (Scheduler policy)

This Job uses deepsonar-chrome-test. Dynamic browser evidence must come from the pinned Chromium + CDP path (chrome-headless.sh / playwright-core connectOverCDP), the same way OpenHarmony Test uses hdc.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json and confirm browser.protocol is cdp. Launch only via the image wrappers; required flags include --no-sandbox and --headless=new.
- Do not install Chrome/Google Chrome, Puppeteer browsers, Selenium Grid, full Playwright browsers, or desktop GUI. Do not apt-get a second Chromium.
- If Chromium/CDP is unavailable or the target page cannot be reached under frozen egress, submit structured inconclusive/needs_human evidence. Never invent DOM, network, or screenshot results from source narration.`;

export const CHROME_AUDIT_RUNTIME_POLICY = `### Chrome/C++ audit toolchain (Scheduler policy)

This Job uses deepsonar-chrome-audit. Evidence is Agent-led C++/source inspection with the preinstalled Clang/LLVM and binutils toolchain.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json. Use git (incl. partial clone), clang, clang-tidy, clangd, llvm, objdump, readelf, llvm-nm as needed.
- The platform does not ship a fixed scan script, Semgrep/gitleaks rule pack, or Chromium browser binary in this image.
- Do not install Chromium, full Chromium source trees as a substitute toolchain, or decision scanners. Missing tools → structured needs_human / inconclusive; never claim browser runtime results from static C++ review alone.`;

export const CHROME_FUZZ_RUNTIME_POLICY = `### Chrome/V8 fuzz runtime (Scheduler policy)

This Job uses deepsonar-chrome-fuzz. Dynamic evidence must come from the pinned V8 d8 and/or v8_json_libfuzzer binaries built into the image.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json and confirm fuzz.target / fuzz.actual. Use d8, libFuzzer, AFL++, and the preinstalled Clang/LLVM sanitizer toolchain.
- Do not rename toy harnesses to d8. Do not install a second V8, full Chromium browser, or substitute fuzz binaries.
- Build/smoke failure or missing d8 → structured needs_human / inconclusive. Never invent crash repros from source comments.`;

export const CLICKHOUSE_TEST_RUNTIME_POLICY = `### ClickHouse official runtime (Scheduler policy)

This Job uses deepsonar-clickhouse-test. Dynamic evidence must come from the pinned official ClickHouse LTS binary (clickhouse / clickhouse-client / clickhouse-local / clickhouse-server wrappers).

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json and confirm clickhouse.official and the pinned version. Prefer image entrypoints (clickhouse-test-env.sh / clickhouse-server.sh).
- Do not install ClickHouse from apt, Docker-in-Docker, or unofficial builds. Do not substitute a toy SQL harness for the official binary.
- If the official binary is missing or the server cannot start under frozen egress/listen policy, submit structured inconclusive/needs_human evidence. Never invent query results from schema narration.`;

export const CLICKHOUSE_AUDIT_RUNTIME_POLICY = `### ClickHouse/C++ audit toolchain (Scheduler policy)

This Job uses deepsonar-clickhouse-audit. Evidence is Agent-led ClickHouse/C++ source inspection with git, CMake/Ninja, Clang/LLVM and binutils.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json. Use cmake, ninja, clang, clang-tidy, clangd, llvm, objdump, readelf, llvm-nm, python3 as needed.
- The platform does not ship a fixed scan script, rule pack, or the ClickHouse server binary in this audit image.
- Do not install official clickhouse-server here as a substitute for deepsonar-clickhouse-test, and do not install decision scanners. Missing tools → needs_human / inconclusive.`;

export const CLICKHOUSE_FUZZ_RUNTIME_POLICY = `### ClickHouse fuzz runtime (Scheduler policy)

This Job uses deepsonar-clickhouse-fuzz. Dynamic evidence must come from the pinned official clickhouse-local plus the image Clang/LLVM sanitizer and AFL++/libFuzzer toolchain.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json and confirm clickhouse.official and fuzz.target. Prefer image entrypoints and the official clickhouse-local binary.
- Do not substitute a toy harness for clickhouse-local. Sanitizer rebuilds may help find issues; qualification still requires the unmodified official binary where applicable.
- Missing official binary or toolchain → structured needs_human / inconclusive. Never invent crash results from source narration.`;

export const OPENHARMONY_AUDIT_RUNTIME_POLICY = `### OpenHarmony host audit toolchain (Scheduler policy)

This Job uses deepsonar-openharmony-audit. Evidence is host-side static analysis (Clang/clang-tidy/cppcheck/sparse + ASan/UBSan build support), not the hdc device protocol.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json. Use the preinstalled C/C++ audit toolchain and openharmony-audit entrypoints.
- Do not treat gdb/strace or Kali process tools as an OpenHarmony device protocol. Do not install DevEco, a full board SDK, or key scanners as substitutes.
- Missing required host tools → structured needs_human / inconclusive. Never invent device results from host build logs.`;

export const OPENHARMONY_FUZZ_RUNTIME_POLICY = `### OpenHarmony host fuzz toolchain (Scheduler policy)

This Job uses deepsonar-openharmony-fuzz. Evidence is host-side dynamic verification (libFuzzer/AFL++ and sanitizer builds), not hdc device I/O.

- Read /opt/deepsonar/manuals/INDEX.md for tool usage manuals (when/how/failure/evidence), then /opt/deepsonar/tool-manifest.json. Use the preinstalled fuzz/sanitizer toolchain and openharmony-fuzz entrypoints.
- Do not install DevEco or rename toy harnesses as substitutes. Missing toolchain → structured needs_human / inconclusive.
- Never invent crash repros from source comments or build logs alone.`;

export type SpecialtyRuntimeImagePolicy = {
  readonly image_key: string;
  readonly marker: string;
  readonly body: string;
};

/** Known official specialty images that receive Scheduler AGENTS.md boundary injection for any role. */
export const SPECIALTY_RUNTIME_IMAGE_POLICIES: ReadonlyArray<SpecialtyRuntimeImagePolicy> = Object.freeze([
  { image_key: "deepsonar-chrome-test", marker: "### Chrome CDP runtime (Scheduler policy)", body: CHROME_TEST_RUNTIME_POLICY },
  { image_key: "deepsonar-chrome-audit", marker: "### Chrome/C++ audit toolchain (Scheduler policy)", body: CHROME_AUDIT_RUNTIME_POLICY },
  { image_key: "deepsonar-chrome-fuzz", marker: "### Chrome/V8 fuzz runtime (Scheduler policy)", body: CHROME_FUZZ_RUNTIME_POLICY },
  { image_key: "deepsonar-clickhouse-test", marker: "### ClickHouse official runtime (Scheduler policy)", body: CLICKHOUSE_TEST_RUNTIME_POLICY },
  { image_key: "deepsonar-clickhouse-audit", marker: "### ClickHouse/C++ audit toolchain (Scheduler policy)", body: CLICKHOUSE_AUDIT_RUNTIME_POLICY },
  { image_key: "deepsonar-clickhouse-fuzz", marker: "### ClickHouse fuzz runtime (Scheduler policy)", body: CLICKHOUSE_FUZZ_RUNTIME_POLICY },
  { image_key: "deepsonar-openharmony-test", marker: "### OpenHarmony hdc device protocol (Scheduler policy)", body: OPENHARMONY_HDC_POLICY },
  { image_key: "deepsonar-openharmony-audit", marker: "### OpenHarmony host audit toolchain (Scheduler policy)", body: OPENHARMONY_AUDIT_RUNTIME_POLICY },
  { image_key: "deepsonar-openharmony-fuzz", marker: "### OpenHarmony host fuzz toolchain (Scheduler policy)", body: OPENHARMONY_FUZZ_RUNTIME_POLICY },
  { image_key: "deepsonar-mobile", marker: "### Mobile device protocols (Scheduler policy)", body: MOBILE_RUNTIME_POLICY },
]);

const SPECIALTY_BY_KEY = new Map(SPECIALTY_RUNTIME_IMAGE_POLICIES.map((item) => [item.image_key, item]));

export function specialtyPolicyForImageKey(imageKey: string | null | undefined): SpecialtyRuntimeImagePolicy | null {
  if (!imageKey) return null;
  return SPECIALTY_BY_KEY.get(imageKey) ?? null;
}

export function appendPolicyBlock(text: string, marker: string, body: string): string {
  if (text.includes(marker)) return text;
  return `${text}${text ? "\n\n" : ""}${body}`;
}
