import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }))[0];
const config = JSON.parse(readFileSync(configUrl, "utf8"));
const maxSizeMiB = config.toolsets[toolset].maxSizeMiB;
const sizeMiB = inspect.Size / 1024 / 1024;
if (sizeMiB > maxSizeMiB) throw new Error(`${image} is ${sizeMiB.toFixed(1)} MiB; budget is ${maxSizeMiB} MiB`);
console.log(`${image} hardened smoke passed; size=${sizeMiB.toFixed(1)} MiB (budget ${maxSizeMiB} MiB)`);
