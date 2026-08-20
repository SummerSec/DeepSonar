#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const helper = join(root, "deploy/openharmony-hdc.sh");

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

console.log("OpenHarmony hdc helper smoke passed (no real device)");
