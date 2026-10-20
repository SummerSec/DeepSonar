#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function toBashPath(value) {
  if (process.platform !== "win32") return value;
  const match = String(value).match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return String(value).replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function spawnWsl(args, options = {}) {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = spawnSync("wsl.exe", args, options);
    const transient = result.status === -1 || result.status === 0xffffffff
      || /Wsl\/Service\/0x8007274c/i.test(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    if (!transient) return result;
  }
  return result;
}

function runHelper(helper, args, env) {
  const pathKeys = new Set(["ADB_BIN", "HDC_BIN", "IDEVICE_ID_BIN", "APKCHECKPACK_BIN", "MOBILE_PYTHON"]);
  const pathDirs = [bashSupportDir, ...String(env.BASH_PATH_DIRS ?? "").split(";").filter(Boolean)].map(toBashPath);
  const normalizedEnv = Object.fromEntries(Object.entries(env)
    .filter(([key]) => key !== "PATH" && key !== "BASH_PATH_DIRS")
    .map(([key, value]) => [key, pathKeys.has(key) ? toBashPath(value) : value]));
  const bashPath = [...pathDirs, "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":");
  if (process.platform === "win32") {
    const envArgs = Object.entries({ ...normalizedEnv, PATH: bashPath }).map(([key, value]) => `${key}=${value}`);
    return spawnWsl([
      "--exec", "env", ...envArgs, "bash", toBashPath(join(root, helper)),
      ...args.map((value) => /^[A-Za-z]:[\\/]/.test(value) ? toBashPath(value) : value),
    ], { encoding: "utf8" });
  }
  return spawnSync("bash", [join(root, helper), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...normalizedEnv, ...(pathDirs.length > 0 ? { PATH: bashPath } : {}) },
  });
}

function writeFake(dirPrefix, name, script) {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const bin = join(dir, name);
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  if (process.platform === "win32") spawnWsl(["--exec", "chmod", "+x", toBashPath(bin)]);
  return bin;
}

const jqShim = writeFake("mobile-support-", "jq", `#!/usr/bin/env python3
import json, sys
text = sys.stdin.read()
program = " ".join(sys.argv[1:])
protocol = "usbmuxd" if "usbmuxd" in program else "hdc"
targets = [line.strip() for line in text.splitlines() if line.strip()]
print(json.dumps({"protocol": protocol, "status": "ok", "targets": targets}, separators=(",", ":")))
`);
const bashSupportDir = dirname(jqShim);

const versionAdb = writeFake("mobile-adb-", "adb", `#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then
  echo 'Android Debug Bridge version 1.0.41'
  echo 'Version 36.0.0-13206524'
  exit 0
fi
if [[ "$1" == "devices" ]]; then
  echo 'List of devices attached'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const version = runHelper("deploy/mobile-adb.sh", ["--check"], { ADB_BIN: versionAdb });
if (version.status !== 0 || !version.stdout.includes("Android Debug Bridge version")) {
  throw new Error(`adb version smoke failed: status=${version.status}\n${version.stdout}\n${version.stderr}`);
}
if (!version.stdout.includes("no_adb_target") || !version.stdout.includes("needs_human") || !version.stdout.includes("inconclusive")) {
  throw new Error(`empty adb devices must emit structured no-target evidence\n${version.stdout}`);
}

const attachedAdb = writeFake("mobile-adb-", "adb", `#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then
  echo 'Android Debug Bridge version 1.0.41'
  exit 0
fi
if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const attached = runHelper("deploy/mobile-adb.sh", ["--check"], { ADB_BIN: attachedAdb });
if (attached.status !== 0 || attached.stdout.includes("no_adb_target")) {
  throw new Error(`attached device must not request human\n${attached.stdout}\n${attached.stderr}`);
}

const missingVersion = writeFake("mobile-adb-", "adb", `#!/usr/bin/env bash
echo 'cannot connect'
exit 1
`);
const missing = runHelper("deploy/mobile-adb.sh", ["--check"], { ADB_BIN: missingVersion });
if (missing.status === 0) {
  throw new Error("adb without a version line must fail closed");
}

const hdcVersion = writeFake("mobile-hdc-", "hdc", `#!/usr/bin/env bash
if [[ "$1" == "version" || "$1" == "-v" ]]; then
  echo 'Ver: 3.2.0b'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const hdcCheck = runHelper("deploy/mobile-hdc.sh", ["--check"], { HDC_BIN: hdcVersion });
if (hdcCheck.status !== 0 || !hdcCheck.stdout.includes("Ver: 3.2.0b")) {
  throw new Error(`hdc version smoke failed: status=${hdcCheck.status}\n${hdcCheck.stdout}\n${hdcCheck.stderr}`);
}

const qemuSplitHdc = writeFake("mobile-hdc-", "hdc", `#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then
  echo 'Connect server failed'
  exit 1
fi
if [[ "$1" == "-v" ]]; then
  echo 'Ver: 3.2.0b'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const qemuSplit = runHelper("deploy/mobile-hdc.sh", ["--check"], { HDC_BIN: qemuSplitHdc });
if (qemuSplit.status !== 0 || !qemuSplit.stdout.includes("Ver: 3.2.0b")) {
  throw new Error(`qemu split hdc version/-v must pass: status=${qemuSplit.status}\n${qemuSplit.stdout}\n${qemuSplit.stderr}`);
}

const emptyHdc = writeFake("mobile-hdc-", "hdc", `#!/usr/bin/env bash
if [[ "$1" == "list" && "$2" == "targets" ]]; then
  printf '[Empty]\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const empty = runHelper("deploy/mobile-hdc.sh", ["targets"], { HDC_BIN: emptyHdc });
if (empty.status !== 2) throw new Error(`empty hdc targets must exit 2, got ${empty.status}\n${empty.stdout}\n${empty.stderr}`);
const emptyJson = JSON.parse(empty.stdout);
if (emptyJson.status !== "needs_human" || emptyJson.verdict !== "inconclusive" || emptyJson.reason !== "no_hdc_target") {
  throw new Error(`empty hdc targets JSON contract drift: ${empty.stdout}`);
}

const noiseOnlyHdc = writeFake("mobile-hdc-", "hdc", `#!/usr/bin/env bash
if [[ "$1" == "list" && "$2" == "targets" ]]; then
  printf 'Connect server failed\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const noiseOnly = runHelper("deploy/mobile-hdc.sh", ["targets"], { HDC_BIN: noiseOnlyHdc });
if (noiseOnly.status !== 2) throw new Error(`hdc server noise must be treated as no target, got ${noiseOnly.status}\n${noiseOnly.stdout}`);
const noiseOnlyJson = JSON.parse(noiseOnly.stdout);
if (noiseOnlyJson.reason !== "no_hdc_target") throw new Error(`hdc server noise JSON drift: ${noiseOnly.stdout}`);

const noisyHdc = writeFake("mobile-hdc-", "hdc", `#!/usr/bin/env bash
if [[ "$1" == "list" && "$2" == "targets" ]]; then
  printf 'Connect server failed\\n127.0.0.1:5555\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const noisy = runHelper("deploy/mobile-hdc.sh", ["targets"], { HDC_BIN: noisyHdc });
if (noisy.status !== 0) throw new Error(`noisy hdc targets failed: ${noisy.status}\n${noisy.stdout}\n${noisy.stderr}`);
const noisyJson = JSON.parse(noisy.stdout);
if (noisyJson.status !== "ok" || noisyJson.targets?.[0] !== "127.0.0.1:5555" || noisyJson.targets.length !== 1) {
  throw new Error(`noisy hdc stderr must not become a target: ${noisy.stdout}`);
}

const presentHdc = writeFake("mobile-hdc-", "hdc", `#!/usr/bin/env bash
if [[ "$1" == "list" && "$2" == "targets" ]]; then
  printf '127.0.0.1:5555\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const present = runHelper("deploy/mobile-hdc.sh", ["targets"], { HDC_BIN: presentHdc });
if (present.status !== 0) throw new Error(`present hdc targets failed: ${present.status}\n${present.stdout}\n${present.stderr}`);
const presentJson = JSON.parse(present.stdout);
if (presentJson.status !== "ok" || presentJson.targets?.[0] !== "127.0.0.1:5555") {
  throw new Error(`present hdc targets JSON drift: ${present.stdout}`);
}

const emptyIos = writeFake("mobile-ios-", "idevice_id", `#!/usr/bin/env bash
exit 0
`);
const iosDir = dirname(emptyIos);
for (const name of ["ideviceinstaller", "plistutil", "iproxy"]) {
  writeFileSync(join(iosDir, name), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(iosDir, name), 0o755);
  if (process.platform === "win32") spawnWsl(["--exec", "chmod", "+x", toBashPath(join(iosDir, name))]);
}
const iosCheck = runHelper("deploy/mobile-ios.sh", ["--check"], {
  IDEVICE_ID_BIN: emptyIos,
  BASH_PATH_DIRS: iosDir,
});
if (iosCheck.status !== 0 || !iosCheck.stdout.includes("no_ios_target") || !iosCheck.stdout.includes("needs_human")) {
  throw new Error(`empty idevice_id must emit structured no-target evidence\n${iosCheck.stdout}\n${iosCheck.stderr}`);
}

const iosDevices = runHelper("deploy/mobile-ios.sh", ["devices"], {
  IDEVICE_ID_BIN: emptyIos,
  BASH_PATH_DIRS: iosDir,
});
if (iosDevices.status !== 2) throw new Error(`empty ios devices must exit 2, got ${iosDevices.status}\n${iosDevices.stdout}`);
const iosJson = JSON.parse(iosDevices.stdout);
if (iosJson.status !== "needs_human" || iosJson.reason !== "no_ios_target") {
  throw new Error(`empty ios devices JSON contract drift: ${iosDevices.stdout}`);
}

const hapDir = mkdtempSync(join(tmpdir(), "mobile-hap-"));
const hapInner = join(hapDir, "app");
mkdirSync(hapInner);
writeFileSync(join(hapInner, "pack.info"), '{"app":{"bundleName":"com.example.hap"}}\n');
writeFileSync(join(hapInner, "module.json"), '{"module":{"name":"entry"}}\n');
const hapFile = join(hapDir, "sample.hap");
const zip = spawnSync("python3", ["-c", `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(hapFile)}, "w")
z.write(${JSON.stringify(join(hapInner, "pack.info"))}, "pack.info")
z.write(${JSON.stringify(join(hapInner, "module.json"))}, "module.json")
z.close()
`], { encoding: "utf8" });
if (zip.status !== 0) throw new Error(`failed to write sample HAP: ${zip.stderr}`);
const hapCheck = runHelper("deploy/mobile-hap.sh", ["--check"], {});
if (hapCheck.status !== 0) throw new Error(`hap --check failed: ${hapCheck.stderr}`);
const hapInspect = runHelper("deploy/mobile-hap.sh", ["inspect", hapFile], {});
if (hapInspect.status !== 0 || !hapInspect.stdout.includes("pack.info") || !hapInspect.stdout.includes("com.example.hap")) {
  throw new Error(`hap inspect must print pack.info\n${hapInspect.stdout}\n${hapInspect.stderr}`);
}

const soDir = mkdtempSync(join(tmpdir(), "mobile-so-"));
const soBin = writeFake("mobile-so-", "r2", `#!/usr/bin/env bash
if [[ "$1" == "-qv" ]]; then
  echo '6.2.0'
  exit 0
fi
echo 'ELF header'
echo 'iI'
exit 0
`);
for (const [name, script] of [
  ["readelf", "#!/usr/bin/env bash\necho 'ELF Header'\nexit 0\n"],
  ["objdump", "#!/usr/bin/env bash\necho 'GNU objdump 2.40'\nexit 0\n"],
  ["nm", "#!/usr/bin/env bash\nexit 0\n"],
  ["file", "#!/usr/bin/env bash\necho \"$1: ELF 64-bit LSB shared object\"\nexit 0\n"],
  ["python", "#!/usr/bin/env bash\necho '1.0.0'\nexit 0\n"],
]) {
  writeFileSync(join(soDir, name), script);
  chmodSync(join(soDir, name), 0o755);
  if (process.platform === "win32") spawnWsl(["--exec", "chmod", "+x", toBashPath(join(soDir, name))]);
}
const soCheck = runHelper("deploy/mobile-so.sh", ["--check"], {
  BASH_PATH_DIRS: [soDir, dirname(soBin)].join(";"),
  MOBILE_PYTHON: join(soDir, "python"),
});
if (soCheck.status !== 0 || !soCheck.stdout.includes("binutils + radare2 + LIEF")) {
  throw new Error(`so --check failed: ${soCheck.status}\n${soCheck.stdout}\n${soCheck.stderr}`);
}
const soFile = join(soDir, "libdemo.so");
writeFileSync(soFile, "not-a-real-elf");
const soInspect = runHelper("deploy/mobile-so.sh", ["inspect", soFile], {
  BASH_PATH_DIRS: [soDir, dirname(soBin)].join(";"),
  MOBILE_PYTHON: join(soDir, "python"),
});
if (soInspect.status !== 0 || !soInspect.stdout.includes("readelf") || !soInspect.stdout.includes("LIEF")) {
  throw new Error(`so inspect must print readelf/LIEF sections\n${soInspect.stdout}\n${soInspect.stderr}`);
}

const apkcheckpack = writeFake("mobile-apkcheckpack-", "ApkCheckPack", `#!/usr/bin/env bash
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  echo 'APK检测工具 - 用于检测APK文件中的特征'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const apkHelp = runHelper("deploy/mobile-apkcheckpack-bin.sh", ["-h"], { APKCHECKPACK_BIN: apkcheckpack });
if (apkHelp.status !== 0 || !apkHelp.stdout.includes("APK检测工具")) {
  throw new Error(`apkcheckpack -h smoke failed: status=${apkHelp.status}\n${apkHelp.stdout}\n${apkHelp.stderr}`);
}
const apkMissing = runHelper("deploy/mobile-apkcheckpack-bin.sh", ["-h"], {
  APKCHECKPACK_BIN: join(tmpdir(), "missing-apkcheckpack-binary"),
});
if (apkMissing.status !== 127) {
  throw new Error(`missing apkcheckpack must exit 127, got ${apkMissing.status}\n${apkMissing.stdout}\n${apkMissing.stderr}`);
}


const mobileRuntime = JSON.parse(readFileSync(join(root, "agent-harness/mobile-runtime.json"), "utf8"));
const droidascPin = mobileRuntime.managed?.pip?.droidasc;
if (droidascPin?.version !== "0.1.1.post1" || droidascPin?.license !== "Apache-2.0") {
  throw new Error(`mobile-runtime.json must pin installable droidasc 0.1.1.post1 Apache-2.0, got ${JSON.stringify(droidascPin)}`);
}
if (!Array.isArray(droidascPin.capabilities) || !droidascPin.capabilities.includes("apk-xref-search")) {
  throw new Error(`droidasc capabilities must include apk-xref-search: ${JSON.stringify(droidascPin.capabilities)}`);
}
if (droidascPin.role !== "explicit-fallback" || droidascPin.entrypoint !== "droidasc-python") {
  throw new Error(`Python droidasc must be the explicit droidasc-python fallback: ${JSON.stringify(droidascPin)}`);
}
const rustAscPin = mobileRuntime.sourceBuilds?.rust_ASC;
if (rustAscPin?.version !== "0.1.1" || rustAscPin?.license !== "Apache-2.0" || rustAscPin?.commit !== "236dd096669c99eb30f6e1af0b24e668eff55dd5") {
  throw new Error(`mobile-runtime.json must pin rust_ASC 0.1.1 @236dd096 Apache-2.0, got ${JSON.stringify(rustAscPin)}`);
}
if (!rustAscPin.capabilities?.includes("apk-xref-search") || rustAscPin.entrypoints?.default !== "rust_ASC") {
  throw new Error(`rust_ASC must be the default apk-xref-search implementation: ${JSON.stringify(rustAscPin)}`);
}
const mobileDockerfile = readFileSync(join(root, "deploy/Dockerfile.agent-mobile"), "utf8");
if (!mobileDockerfile.includes("ARG DROIDASC_VERSION=0.1.1.post1") || !mobileDockerfile.includes("droidasc==${DROIDASC_VERSION}")) {
  throw new Error("Dockerfile.agent-mobile must pin and install droidasc==${DROIDASC_VERSION} for the explicit fallback");
}
if (!mobileDockerfile.includes("/opt/deepsonar/bin/droidasc-python") || !mobileDockerfile.includes("/opt/deepsonar/bin/rust_ASC")) {
  throw new Error("Dockerfile.agent-mobile must install rust_ASC and the droidasc-python fallback entry");
}
if (!mobileDockerfile.includes("--locked --no-default-features")) {
  throw new Error("Dockerfile.agent-mobile must build rust_ASC with --locked --no-default-features");
}

function runBash(script, env) {
  if (process.platform === "win32") {
    const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    return spawnWsl(["--exec", "env", ...envArgs, "bash", "-c", script], { encoding: "utf8" });
  }
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
}

const ascDir = mkdtempSync(join(tmpdir(), "mobile-asc-"));
const pythonMarker = join(ascDir, "python-ran");
const rustAscFakeSource = `#!/usr/bin/env bash
# Fake rust_ASC 0.1.1 mirroring upstream clap behavior: help on stderr with exit 1.
case "\${1:-}" in
  --help|-h|help)
    printf 'Error: ASC tooling entry.\\n\\nUsage: rust_ASC <COMMAND>\\n\\nCommands:\\n  getclass\\n  listclass\\n  export\\n  getmanifest\\n  findrefs\\n' >&2
    exit 1
    ;;
  mcp)
    printf "Error: error: unrecognized subcommand 'mcp'\\n\\nUsage: rust_ASC <COMMAND>\\n" >&2
    exit 1
    ;;
esac
for arg in "$@"; do
  if [[ "$arg" == --threads || "$arg" == --threads=* ]]; then
    printf "Error: error: unexpected argument '--threads' found\\n" >&2
    exit 1
  fi
  if [[ "$arg" == "Lfail;" ]]; then
    printf 'Error: Class Lfail; not found in APK.\\n' >&2
    exit 3
  fi
done
printf 'ARGS:%s\\n' "$*"
`;
const rustAscHome = join(ascDir, "rust-asc");
mkdirSync(rustAscHome);
const rustAscFake = join(rustAscHome, "rust_ASC");
writeFileSync(rustAscFake, rustAscFakeSource);
chmodSync(rustAscFake, 0o755);
if (process.platform === "win32") spawnWsl(["--exec", "chmod", "+x", toBashPath(rustAscFake)]);
const rustAscSha = createHash("sha256").update(readFileSync(rustAscFake)).digest("hex");
const rustBuildinfo = (sha) => [
  "implementation=rust_ASC",
  "version=0.1.1",
  "tag=v0.1.1",
  "commit=236dd096669c99eb30f6e1af0b24e668eff55dd5",
  "radguard_commit=290de20c925c4a2c7642b1a63c9997185a06e130",
  "cargo_features=--locked --no-default-features",
  `binary_sha256=${sha}`,
  "",
].join("\n");
writeFileSync(join(rustAscHome, "BUILDINFO"), rustBuildinfo(rustAscSha));

const pythonHome = join(ascDir, "droidasc-python");
mkdirSync(pythonHome);
writeFileSync(join(pythonHome, "BUILDINFO"), "implementation=droidasc-python\npackage=droidasc\nversion=0.1.1.post1\nrole=explicit-fallback\n");
const pythonFake = writeFake("mobile-droidasc-py-", "droidasc", `#!/usr/bin/env bash
: > ${JSON.stringify(toBashPath(pythonMarker))}
if [[ "\${1:-}" == "--help" ]]; then
  echo 'usage: droidasc [-h] {getclass,listclass,getmanifest,findrefs} ...'
  exit 0
fi
printf 'PY:%s\\n' "$*"
`);

// Minimal valid ZIP (empty archive: end-of-central-directory record only) and a corrupt one.
const goodApk = join(ascDir, "fixture.apk");
writeFileSync(goodApk, Buffer.concat([Buffer.from("PK\x05\x06", "latin1"), Buffer.alloc(18)]));
const corruptApk = join(ascDir, "corrupt.apk");
writeFileSync(corruptApk, "PK\x03\x04not-a-zip");
const missingApk = join(ascDir, "missing.apk");

const ascEnv = {
  RUST_ASC_HOME: toBashPath(rustAscHome),
  DROIDASC_PYTHON_HOME: toBashPath(pythonHome),
  DROIDASC_PYTHON_BIN: toBashPath(pythonFake),
};
const droidasc = (args, extra = {}) => runHelper("deploy/mobile-droidasc.sh", args, { ...ascEnv, ...extra });
const droidascPython = (args) => runHelper("deploy/mobile-droidasc-python.sh", args, ascEnv);
const bashApk = (value) => toBashPath(value);
const assertNoPython = (label) => {
  if (existsSync(pythonMarker)) throw new Error(`${label}: droidasc must never fall back to Python ASC`);
};

const ascHelp = droidasc(["--help"]);
if (ascHelp.status !== 0 || !ascHelp.stdout.includes("Usage: rust_ASC") || ascHelp.stdout.startsWith("Error:") || !ascHelp.stderr.includes("implementation=rust_ASC")) {
  throw new Error(`droidasc --help must normalize rust_ASC help to stdout/exit 0: status=${ascHelp.status}\n${ascHelp.stdout}\n${ascHelp.stderr}`);
}
const ascThreads = droidasc(["listclass", "--threads", "4", bashApk(goodApk)]);
if (ascThreads.status !== 0 || !ascThreads.stdout.includes(`ARGS:listclass --thread 4 ${bashApk(goodApk)}`) || !ascThreads.stderr.includes("renamed_threads=1") || !ascThreads.stderr.includes("version=0.1.1")) {
  throw new Error(`droidasc must rename --threads to --thread in place: status=${ascThreads.status}\n${ascThreads.stdout}\n${ascThreads.stderr}`);
}
const ascThreadsEq = droidasc(["findrefs", "--threads=2", bashApk(goodApk), "string", "token"]);
if (ascThreadsEq.status !== 0 || !ascThreadsEq.stdout.includes(`ARGS:findrefs --thread=2 ${bashApk(goodApk)} string token`)) {
  throw new Error(`droidasc must rename --threads=N to --thread=N: status=${ascThreadsEq.status}\n${ascThreadsEq.stdout}\n${ascThreadsEq.stderr}`);
}
const ascPlain = droidasc(["getclass", "--thread", "8", "-o", "Main.java", bashApk(goodApk), "Lcom/poc/Main;"]);
if (ascPlain.status !== 0 || !ascPlain.stdout.includes("ARGS:getclass --thread 8 -o Main.java") || !ascPlain.stderr.includes("renamed_threads=0")) {
  throw new Error(`droidasc must pass native rust_ASC arguments unchanged: status=${ascPlain.status}\n${ascPlain.stdout}\n${ascPlain.stderr}`);
}
for (const [label, apk, message] of [["corrupt", corruptApk, "EOCD not found"], ["missing", missingApk, "No such file"]]) {
  const result = droidasc(["findrefs", bashApk(apk), "string", "token"]);
  if (result.status !== 1 || result.stdout.includes("ARGS:") || !result.stderr.includes("preflight=failed") || !result.stderr.includes(message)) {
    throw new Error(`droidasc must fail the ${label} APK preflight instead of returning an empty exit-0 findrefs: status=${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}
const ascFailure = droidasc(["getclass", bashApk(goodApk), "Lfail;"]);
if (ascFailure.status !== 3 || !ascFailure.stderr.includes("not found in APK")) {
  throw new Error(`droidasc must propagate rust_ASC failures unchanged: status=${ascFailure.status}\n${ascFailure.stdout}\n${ascFailure.stderr}`);
}
assertNoPython("rust failure");
const ascMissingBin = droidasc(["listclass", bashApk(goodApk)], { RUST_ASC_BIN: toBashPath(join(ascDir, "missing-rust-asc")) });
if (ascMissingBin.status !== 127 || !ascMissingBin.stderr.includes("droidasc-python")) {
  throw new Error(`missing rust_ASC must exit 127 without fallback: status=${ascMissingBin.status}\n${ascMissingBin.stdout}\n${ascMissingBin.stderr}`);
}
assertNoPython("missing rust_ASC");
const ascGui = droidasc([bashApk(goodApk), "--gui"]);
if (ascGui.status !== 2) throw new Error(`droidasc --gui must be rejected: status=${ascGui.status}\n${ascGui.stderr}`);
const ascInfo = droidasc(["--impl-info"]);
if (ascInfo.status !== 0 || !ascInfo.stdout.includes("entry=droidasc") || !ascInfo.stdout.includes("implementation=rust_ASC") || !ascInfo.stdout.includes("commit=236dd096669c99eb30f6e1af0b24e668eff55dd5")) {
  throw new Error(`droidasc --impl-info must report rust_ASC provenance: status=${ascInfo.status}\n${ascInfo.stdout}\n${ascInfo.stderr}`);
}

const pyRun = droidascPython(["getclass", bashApk(goodApk), "Lcom/poc/Main;", "--threads", "16"]);
if (pyRun.status !== 0 || !pyRun.stdout.includes("--threads 16") || !pyRun.stderr.includes("implementation=droidasc-python version=0.1.1.post1")) {
  throw new Error(`droidasc-python must run Python ASC explicitly with original arguments: status=${pyRun.status}\n${pyRun.stdout}\n${pyRun.stderr}`);
}
if (!existsSync(pythonMarker)) throw new Error("droidasc-python did not execute the Python ASC binary");
const pyGui = droidascPython([bashApk(goodApk), "--gui"]);
if (pyGui.status !== 2) throw new Error(`droidasc-python --gui must be rejected: status=${pyGui.status}\n${pyGui.stderr}`);
const pyInfo = droidascPython(["--impl-info"]);
if (pyInfo.status !== 0 || !pyInfo.stdout.includes("entry=droidasc-python") || !pyInfo.stdout.includes("version=0.1.1.post1")) {
  throw new Error(`droidasc-python --impl-info must report Python provenance: status=${pyInfo.status}\n${pyInfo.stdout}\n${pyInfo.stderr}`);
}

// mobile-env.sh rust_ASC help self-check: upstream --help exits 1, so smoke_rust_asc must accept 0/1 with
// complete help text, but still fail on launch errors, an MCP-enabled build, or a binary/record mismatch.
const mobileEnvSource = readFileSync(join(root, "deploy/mobile-env.sh"), "utf8");
const smokeStart = mobileEnvSource.indexOf("buildinfo_value() {");
const smokeEnd = mobileEnvSource.indexOf("smoke_droidasc_entries() {");
if (smokeStart < 0 || smokeEnd < 0) throw new Error("mobile-env.sh must define buildinfo_value and smoke_rust_asc before smoke_droidasc_entries");
const smokeFunctions = mobileEnvSource.slice(smokeStart, smokeEnd);
const runSmokeRustAsc = (home) => runBash(`set -euo pipefail\n${smokeFunctions}\nsmoke_rust_asc`, { RUST_ASC_HOME: toBashPath(home) });
const smokeOk = runSmokeRustAsc(rustAscHome);
if (smokeOk.status !== 0) throw new Error(`mobile-env.sh rust_ASC help smoke must accept upstream exit-1 help: status=${smokeOk.status}\n${smokeOk.stderr}`);
const variantHome = (name, source, sha) => {
  const home = join(ascDir, name);
  mkdirSync(home);
  const bin = join(home, "rust_ASC");
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  if (process.platform === "win32") spawnWsl(["--exec", "chmod", "+x", toBashPath(bin)]);
  writeFileSync(join(home, "BUILDINFO"), rustBuildinfo(sha ?? createHash("sha256").update(readFileSync(bin)).digest("hex")));
  return home;
};
// Same help text and MCP-free behavior, but --help aborts (exit 134, e.g. panic=abort): only the exit-code gate can catch it.
const crashingHome = variantHome("rust-asc-crash", rustAscFakeSource.replace("<COMMAND>\\n\\nCommands:\\n  getclass\\n  listclass\\n  export\\n  getmanifest\\n  findrefs\\n' >&2\n    exit 1", "<COMMAND>\\n\\nCommands:\\n  getclass\\n  listclass\\n  export\\n  getmanifest\\n  findrefs\\n' >&2\n    exit 134"));
if (!readFileSync(join(crashingHome, "rust_ASC"), "utf8").includes("exit 134")) throw new Error("crash fixture did not switch the help exit code");
const mcpHome = variantHome("rust-asc-mcp", rustAscFakeSource.replace("unrecognized subcommand 'mcp'", "Serve MCP tools over stdio."));
const shaMismatchHome = variantHome("rust-asc-sha", rustAscFakeSource, "0".repeat(64));
for (const [label, home] of [["crash exit 134", crashingHome], ["MCP-enabled build", mcpHome], ["binary SHA mismatch", shaMismatchHome]]) {
  const result = runSmokeRustAsc(home);
  if (result.status === 0) throw new Error(`mobile-env.sh rust_ASC help smoke must fail on ${label}\n${result.stdout}\n${result.stderr}`);
}

console.log("mobile runtime helper smoke ok");
