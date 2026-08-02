import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants, createGzip } from "node:zlib";

const image = process.argv[2];
const toolset = process.argv[3] ?? "base";
const configUrl = process.argv[4] ? new URL(`../${process.argv[4].replaceAll("\\", "/")}`, import.meta.url) : new URL("./runtime-images.json", import.meta.url);
if (!image || !["base", "audit", "kali-minimal"].includes(toolset)) {
  throw new Error("usage: node test-runtime-image.mjs <image> <base|audit|kali-minimal> [config-json]");
}
const commands = ["git --version", "rg --version", "jq --version", "file --version", "python3 --version", "node --version", "claude --version"];
if (toolset !== "base") commands.push("semgrep --version", "gitleaks version", "shellcheck --version", "objdump --version");
commands.push("test -s /opt/deepsonar/tool-manifest.json", "jq -e '.contract == \"deepsonar.runtime.contract/v1\"' /opt/deepsonar/tool-manifest.json");
execFileSync("docker", [
  "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "1", "--memory", "1g", "--pids-limit", "256", image, "sh", "-lc", commands.join(" && "),
], { stdio: "inherit" });

async function compressedArchiveBytes(imageName) {
  const docker = spawn("docker", ["image", "save", imageName], { stdio: ["ignore", "pipe", "inherit"] });
  const gzip = createGzip({ level: constants.Z_BEST_COMPRESSION });
  let bytes = 0;
  gzip.on("data", (chunk) => { bytes += chunk.length; });
  docker.stdout.pipe(gzip);
  await Promise.all([
    new Promise((resolve, reject) => {
      docker.on("error", reject);
      docker.on("close", (code) => code === 0 ? resolve() : reject(new Error(`docker image save exited with ${code}`)));
    }),
    new Promise((resolve, reject) => {
      gzip.on("error", reject);
      gzip.on("end", resolve);
    }),
  ]);
  return bytes;
}

const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }))[0];
const config = JSON.parse(readFileSync(configUrl, "utf8"));
const maxSizeMiB = config.toolsets[toolset].maxSizeMiB;
const unpackedSizeMiB = inspect.Size / 1024 / 1024;
const packageSizeMiB = await compressedArchiveBytes(image) / 1024 / 1024;
if (packageSizeMiB > maxSizeMiB) {
  throw new Error(`${image} compressed package is ${packageSizeMiB.toFixed(1)} MiB; budget is ${maxSizeMiB} MiB (unpacked ${unpackedSizeMiB.toFixed(1)} MiB)`);
}
console.log(`${image} hardened smoke passed; package=${packageSizeMiB.toFixed(1)} MiB (budget ${maxSizeMiB} MiB), unpacked=${unpackedSizeMiB.toFixed(1)} MiB`);
