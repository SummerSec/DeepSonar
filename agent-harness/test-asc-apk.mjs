#!/usr/bin/env node
// Real APK acceptance only: no fake executable or successful skip path.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [image, platform, outputArgument] = process.argv.slice(2);
if (!image || !/^linux\/(amd64|arm64)$/.test(platform ?? "")) {
  throw new Error("Usage: node agent-harness/test-asc-apk.mjs IMAGE linux/{amd64,arm64} [RESULT_DIRECTORY]");
}
const fixture = resolve(root, "agent-harness/fixtures/asc");
const apkHash = createHash("sha256").update(readFileSync(resolve(fixture, "fixture.apk"))).digest("hex");
const pinnedHash = readFileSync(resolve(fixture, "fixture.sha256"), "utf8").split(/\s/)[0];
if (apkHash !== pinnedHash) throw new Error("ASC fixture hash mismatch");
const output = resolve(outputArgument ?? `/tmp/deepsonar-asc-${platform.split("/")[1]}-${Date.now()}`);
mkdirSync(output, { recursive: true });
const inspect = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
if (inspect.status !== 0) throw new Error(`Image must already exist locally: ${inspect.stderr}`);
writeFileSync(resolve(output, "image-inspect.json"), inspect.stdout);
writeFileSync(resolve(output, "invocation.json"), JSON.stringify({
  image, platform, apk_sha256: apkHash,
  note: "Platform selection and uname do not prove native execution; record runner/QEMU separately.",
}, null, 2));

const script = String.raw`
import hashlib, importlib.metadata, json, os, pathlib, platform, subprocess, sys, xml.etree.ElementTree as ET
out = pathlib.Path("/results")
apk = "/fixture/fixture.apk"
clz = "Lorg/deepsonar/fixture/Primary;"
secondary = "Lorg/deepsonar/fixture/Secondary;"
(out / "broken.apk").write_bytes(b"This is deliberately not a ZIP/APK.\n")
cases = [
 ("manifest", ["getmanifest", apk], ["org.deepsonar.fixture"], "success"),
 ("primary", ["getclass", apk, clz], ["Primary", "ping", "marker"], "success"),
 ("secondary", ["getclass", apk, secondary], ["Secondary", "probe"], "success"),
 ("string", ["findrefs", apk, "string", "asc-primary-token"], ["Primary"], "success"),
 ("multidex-string", ["findrefs", apk, "string", "asc-secondary-token"], ["Secondary"], "success"),
 ("type", ["findrefs", apk, "type", clz], ["Primary", "Secondary"], "success"),
 ("method", ["findrefs", apk, "method", "ping"], ["Primary", "Secondary"], "success"),
 ("field", ["findrefs", apk, "field", "marker"], ["Primary", "Secondary"], "success"),
 ("class-filter", ["findrefs", apk, "method", "ping", "--class", clz], ["Primary", "Secondary"], "success"),
 ("fuzzy-filter", ["findrefs", apk, "field", "marker", "--class", "fixture/Prim", "--fuzzy-class"], ["Primary", "Secondary"], "success"),
 ("no-result", ["findrefs", apk, "string", "asc-term-guaranteed-absent-9fc91"], [], "empty"),
 ("missing-class", ["getclass", apk, "Lorg/deepsonar/fixture/Absent;"], [], "failure"),
 ("illegal-class", ["getclass", apk, ""], [], "failure"),
 ("broken-manifest", ["getmanifest", "/results/broken.apk"], [], "failure"),
 ("broken-class", ["getclass", "/results/broken.apk", clz], [], "failure"),
 ("broken-refs", ["findrefs", "/results/broken.apk", "string", "token"], [], "failure"),
 ("bad-option", ["getclass", apk, clz, "--definitely-invalid-option"], [], "failure"),
]
file_cases = {"manifest", "primary", "secondary", "string", "multidex-string", "type", "method", "field", "class-filter", "fuzzy-filter", "no-result"}
results = []
failures = []
for tool in ["rust-asc", "droidasc"]:
 for argument in ["--version", "--help", "mcp"]:
  proc = subprocess.run([tool, argument], text=True, capture_output=True, timeout=60)
  results.append(dict(tool=tool, case=argument, command=[tool, argument],
                      status=proc.returncode, stdout=proc.stdout, stderr=proc.stderr))
  if argument == "--version":
   if proc.returncode != 0 or "v0.1.1" not in proc.stdout or "236dd096669c99eb30f6e1af0b24e668eff55dd5" not in proc.stdout:
    failures.append(tool + ": source version identity mismatch")
  elif argument == "--help":
   if proc.returncode != 0 or not all(token in proc.stdout for token in ["getclass", "findrefs"]) or "mcp" in proc.stdout.lower():
    failures.append(tool + ": help missing CLI commands or exposes MCP")
  elif proc.returncode == 0:
   failures.append(tool + ": MCP must be unavailable")
for tool in ["rust-asc", "droidasc", "droidasc-python"]:
 for name, args, tokens, expected in cases:
  prefix = out / (tool + "-" + name)
  artifact = pathlib.Path(str(prefix) + ".output")
  command = [tool] + args + (["-o", str(artifact)] if name in file_cases else [])
  try:
   proc = subprocess.run(command, text=True, errors="replace", capture_output=True, timeout=60)
   status, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
  except (OSError, subprocess.TimeoutExpired) as error:
   status, stdout, stderr = None, "", str(error)
  pathlib.Path(str(prefix) + ".stdout").write_text(stdout)
  pathlib.Path(str(prefix) + ".stderr").write_text(stderr)
  data = artifact.read_bytes() if artifact.exists() else None
  text = data.decode("utf-8", errors="replace") if data is not None else ""
  problems = []
  if expected == "success":
   if status != 0: problems.append("successful query returned nonzero")
   if data is None: problems.append("requested output file missing")
   if text.strip() != stdout.strip(): problems.append("stdout and requested output disagree")
   for token in tokens:
    if token not in text: problems.append("output lacks semantic marker: " + token)
  elif expected == "empty":
   if status != 0: problems.append("no-match query failed")
   if data is None or text.strip(): problems.append("no-match output file must exist and be empty")
  elif tool != "droidasc-python" and (status is None or status == 0):
   problems.append("invalid input must produce an observable failure")
  # Python's historical negative-input exit semantics are observations, not a
  # compatibility promise. Preserve them next to Rust's stricter requirements.
  if status is None: problems.append("executable missing or timed out")
  result = dict(tool=tool, case=name, command=command, status=status,
                stdout=stdout, stderr=stderr, expected=expected,
                output_sha256=hashlib.sha256(data).hexdigest() if data is not None else None,
                output_bytes=len(data) if data is not None else None, problems=problems)
  results.append(result)
  failures.extend(tool + "/" + name + ": " + problem for problem in problems)
 # Exercise the existing --threads spelling through the documented compatibility entry.
 if tool == "droidasc":
  for thread_args in [["--threads", "2"], ["--threads=2"]]:
   proc = subprocess.run([tool, "getclass", apk, clz] + thread_args,
                         text=True, capture_output=True, timeout=60)
   results.append(dict(tool=tool, case="legacy-threads", command=[tool, "getclass", apk, clz] + thread_args,
                       status=proc.returncode, stdout=proc.stdout, stderr=proc.stderr))
   if proc.returncode != 0 or "Primary" not in proc.stdout:
    failures.append("droidasc --threads compatibility failed")
comparison = []
def xml_semantics(text):
 node = ET.fromstring(text)
 def visit(element):
  return [element.tag, sorted(element.attrib.items()), (element.text or "").strip(),
          [visit(child) for child in element]]
 return visit(node)
for name, _, _, _ in cases:
 selected = {entry["tool"]: entry for entry in results if entry["case"] == name}
 rust, python = selected["droidasc"], selected["droidasc-python"]
 comparison.append(dict(case=name, same_exit=rust["status"] == python["status"],
                        same_stdout=rust["stdout"] == python["stdout"],
                        same_stderr=rust["stderr"] == python["stderr"],
                        same_output=rust["output_sha256"] == python["output_sha256"]))
 if name == "manifest":
  try:
   if xml_semantics(rust["stdout"]) != xml_semantics(python["stdout"]):
    failures.append("Rust/Python decoded manifest semantics differ")
  except ET.ParseError as error:
   failures.append("decoded manifest XML cannot be parsed: " + str(error))
 elif name in file_cases and name not in {"primary", "secondary"}:
  if sorted(rust["stdout"].splitlines()) != sorted(python["stdout"].splitlines()):
   failures.append("Rust/Python reference sets differ: " + name)
report = dict(machine=platform.machine(), python=sys.version,
              python_packages={name: importlib.metadata.version(name) for name in ["droidasc", "androguard"]},
              results=results, comparison=comparison, failures=failures)
(out / "results.json").write_text(json.dumps(report, indent=2))
print(json.dumps(dict(machine=platform.machine(), cases=len(results), failures=failures), indent=2))
sys.exit(1 if failures else 0)
`;
const run = spawnSync("docker", [
  "run", "--rm", "--network", "none", "--platform", platform, "--user", "0",
  "--mount", `type=bind,src=${fixture},dst=/fixture,readonly`,
  "--mount", `type=bind,src=${output},dst=/results`,
  "--entrypoint", "/opt/deepsonar/mobile-venv/bin/python",
  "-i", image, "-",
], { input: script, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
writeFileSync(resolve(output, "runner.stdout"), run.stdout ?? "");
writeFileSync(resolve(output, "runner.stderr"), run.stderr ?? "");
console.log(run.stdout ?? "");
console.log(`ASC APK acceptance evidence: ${output}`);
if (run.error || run.status !== 0) {
  throw new Error(`Real APK acceptance failed (${run.status}): ${run.error ?? run.stderr}`);
}
