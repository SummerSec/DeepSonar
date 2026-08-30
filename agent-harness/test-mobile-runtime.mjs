#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function runHelper(helper, args, env) {
  return spawnSync("bash", [join(root, helper), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeFake(dirPrefix, name, script) {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const bin = join(dir, name);
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

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
const iosDir = emptyIos.slice(0, emptyIos.lastIndexOf("/"));
for (const name of ["ideviceinstaller", "plistutil", "iproxy"]) {
  writeFileSync(join(iosDir, name), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(iosDir, name), 0o755);
}
const iosCheck = runHelper("deploy/mobile-ios.sh", ["--check"], {
  IDEVICE_ID_BIN: emptyIos,
  PATH: `${iosDir}:${process.env.PATH}`,
});
if (iosCheck.status !== 0 || !iosCheck.stdout.includes("no_ios_target") || !iosCheck.stdout.includes("needs_human")) {
  throw new Error(`empty idevice_id must emit structured no-target evidence\n${iosCheck.stdout}\n${iosCheck.stderr}`);
}

const iosDevices = runHelper("deploy/mobile-ios.sh", ["devices"], {
  IDEVICE_ID_BIN: emptyIos,
  PATH: `${iosDir}:${process.env.PATH}`,
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
}
const soCheck = runHelper("deploy/mobile-so.sh", ["--check"], {
  PATH: `${soDir}:${soBin.slice(0, soBin.lastIndexOf("/"))}:${process.env.PATH}`,
  MOBILE_PYTHON: join(soDir, "python"),
});
if (soCheck.status !== 0 || !soCheck.stdout.includes("binutils + radare2 + LIEF")) {
  throw new Error(`so --check failed: ${soCheck.status}\n${soCheck.stdout}\n${soCheck.stderr}`);
}
const soFile = join(soDir, "libdemo.so");
writeFileSync(soFile, "not-a-real-elf");
const soInspect = runHelper("deploy/mobile-so.sh", ["inspect", soFile], {
  PATH: `${soDir}:${soBin.slice(0, soBin.lastIndexOf("/"))}:${process.env.PATH}`,
  MOBILE_PYTHON: join(soDir, "python"),
});
if (soInspect.status !== 0 || !soInspect.stdout.includes("readelf") || !soInspect.stdout.includes("LIEF")) {
  throw new Error(`so inspect must print readelf/LIEF sections\n${soInspect.stdout}\n${soInspect.stderr}`);
}

console.log("mobile runtime helper smoke ok");
