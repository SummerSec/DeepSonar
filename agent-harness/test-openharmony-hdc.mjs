#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const helper = join(root, "deploy/openharmony-hdc.sh");
const envHelper = join(root, "deploy/openharmony-env.sh");

function run(args, env) {
  return spawnSync("bash", [helper, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeFakeHdc(script) {
  const dir = mkdtempSync(join(tmpdir(), "oh-hdc-"));
  const bin = join(dir, "hdc");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

function writeStub(dir, name, script = "#!/usr/bin/env bash\nexit 0\n") {
  const bin = join(dir, name);
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

function qemuSplitScript(versionOut, verboseOut, versionStatus = 0, verboseStatus = 0) {
  return `#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then
  echo '${versionOut}'
  exit ${versionStatus}
fi
if [[ "$1" == "-v" ]]; then
  echo '${verboseOut}'
  exit ${verboseStatus}
fi
echo "unexpected $*" >&2
exit 1
`;
}

const versionHdc = writeFakeHdc(`#!/usr/bin/env bash
if [[ "$1" == "version" || "$1" == "-v" ]]; then
  echo 'Ver: 3.2.0b'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const version = run(["--check"], { HDC_BIN: versionHdc });
if (version.status !== 0 || !version.stdout.includes("Ver: 3.2.0b")) {
  throw new Error(`hdc version smoke failed: status=${version.status}\n${version.stdout}\n${version.stderr}`);
}

const qemuSplitHdc = writeFakeHdc(qemuSplitScript("Connect server failed", "Ver: 3.2.0b"));
const qemuSplit = run(["--check"], { HDC_BIN: qemuSplitHdc });
if (qemuSplit.status !== 0 || !qemuSplit.stdout.includes("Ver: 3.2.0b")) {
  throw new Error(`qemu split hdc version/-v must pass: status=${qemuSplit.status}\n${qemuSplit.stdout}\n${qemuSplit.stderr}`);
}

const qemuSplitReverseHdc = writeFakeHdc(qemuSplitScript("Ver: 3.2.0b", "Connect server failed"));
const qemuSplitReverse = run(["--check"], { HDC_BIN: qemuSplitReverseHdc });
if (qemuSplitReverse.status !== 0 || !qemuSplitReverse.stdout.includes("Ver: 3.2.0b")) {
  throw new Error(`qemu reverse split must pass: status=${qemuSplitReverse.status}\n${qemuSplitReverse.stdout}\n${qemuSplitReverse.stderr}`);
}

const qemuNonzeroHdc = writeFakeHdc(qemuSplitScript("Connect server failed", "Ver: 3.2.0b", 1, 0));
const qemuNonzero = run(["--check"], { HDC_BIN: qemuNonzeroHdc });
if (qemuNonzero.status !== 0 || !qemuNonzero.stdout.includes("Ver: 3.2.0b")) {
  throw new Error(`Connect server failed nonzero exit must not fail closed: status=${qemuNonzero.status}\n${qemuNonzero.stdout}\n${qemuNonzero.stderr}`);
}

const noVersionHdc = writeFakeHdc(qemuSplitScript("Connect server failed", "Connect server failed"));
const noVersion = run(["--check"], { HDC_BIN: noVersionHdc });
if (noVersion.status === 0) {
  throw new Error("hdc without Ver: must fail closed");
}

const emptyHdc = writeFakeHdc(`#!/usr/bin/env bash
if [[ "$1" == "list" && "$2" == "targets" ]]; then
  printf '[Empty]\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const empty = run(["targets"], { HDC_BIN: emptyHdc });
if (empty.status !== 2) throw new Error(`empty targets must exit 2, got ${empty.status}\n${empty.stdout}\n${empty.stderr}`);
const emptyJson = JSON.parse(empty.stdout);
if (emptyJson.status !== "needs_human" || emptyJson.verdict !== "inconclusive" || emptyJson.reason !== "no_hdc_target") {
  throw new Error(`empty targets JSON contract drift: ${empty.stdout}`);
}
if (!Array.isArray(emptyJson.targets) || emptyJson.targets.length !== 0) {
  throw new Error(`empty targets must not invent devices: ${empty.stdout}`);
}

const presentHdc = writeFakeHdc(`#!/usr/bin/env bash
if [[ "$1" == "list" && "$2" == "targets" ]]; then
  printf '127.0.0.1:5555\\n'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`);
const present = run(["targets"], { HDC_BIN: presentHdc });
if (present.status !== 0) throw new Error(`present targets failed: ${present.status}\n${present.stdout}\n${present.stderr}`);
const presentJson = JSON.parse(present.stdout);
if (presentJson.status !== "ok" || presentJson.targets?.[0] !== "127.0.0.1:5555") {
  throw new Error(`present targets JSON drift: ${present.stdout}`);
}

const missing = run(["--check"], { HDC_BIN: join(tmpdir(), "missing-hdc-binary") });
if (missing.status === 0) throw new Error("missing hdc must fail closed");

function runEnvCheck({ hdcScript, includeHdc = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oh-env-"));
  for (const name of ["git", "git-lfs", "repo", "cmake", "ninja", "ccache", "node", "claude"]) {
    writeStub(dir, name);
  }
  if (includeHdc) writeStub(dir, "hdc", hdcScript);
  const manifest = join(dir, "tool-manifest.json");
  writeFileSync(manifest, JSON.stringify({
    contract: "deepsonar.runtime.contract/v1",
    imageKey: "deepsonar-openharmony-test",
    device: { protocol: "hdc" },
  }));
  return spawnSync("bash", [envHelper, "--check", "--hdc"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      DEEPSONAR_TOOL_MANIFEST: manifest,
    },
  });
}

const envQemu = runEnvCheck({ hdcScript: qemuSplitScript("Connect server failed", "Ver: 3.2.0b") });
if (envQemu.status !== 0 || !envQemu.stdout.includes("官方 hdc 已就绪")) {
  throw new Error(`env --check --hdc qemu split must pass: status=${envQemu.status}\n${envQemu.stdout}\n${envQemu.stderr}`);
}

const envNoVer = runEnvCheck({ hdcScript: qemuSplitScript("Connect server failed", "Connect server failed") });
if (envNoVer.status === 0) {
  throw new Error("env --check --hdc without Ver: must fail closed");
}

const envMissing = runEnvCheck({ includeHdc: false });
if (envMissing.status === 0) {
  throw new Error("env --check --hdc missing hdc must fail closed");
}

console.log("OpenHarmony hdc helper smoke passed (no real device)");
