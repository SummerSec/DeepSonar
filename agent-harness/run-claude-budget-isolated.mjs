// Actions-only harness: production CLI, proxy and synthetic provider share one
// Docker network namespace with no external interfaces. Never mount the socket.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_REQUEST_POLICY_SOURCE } from "../packages/runtime-sandbox/dist/model-request-policy.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "../packages/runtime-sandbox/dist/runtime-adapters.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), "claude-budget-isolated-"));
const name = `claude-budget-${randomUUID()}`;
const image = process.env.CLAUDE_BUDGET_IMAGE || "deepsonar-base:reverse-ci";
try {
  await chmod(dir, 0o755);
  execFileSync("pnpm", ["exec", "tsc", "-p", "agent-harness/tsconfig.claude-budget.json", "--noEmit", "false",
    "--declaration", "false", "--sourceMap", "false", "--rootDir", "agent-harness", "--outDir", dir], { cwd: root, stdio: "inherit" });
  await rename(path.join(dir, "claude-request-budget-cli.test.js"), path.join(dir, "claude-request-budget-cli.test.mjs"));
  await writeFile(path.join(dir, "runtime-fixture.json"), JSON.stringify({
    policySource: MODEL_REQUEST_POLICY_SOURCE,
    encodedInput: AGENT_CLI_RUNTIME_ADAPTERS["claude-code"].encodeInput("Run the supplied synthetic Bash tool once, then report its result."),
  }), { mode: 0o644 });
  // No registry lookup is allowed here: CI has just built this exact local tag.
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  execFileSync("docker", ["run", "--rm", "--pull", "never", "--name", name,
    "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:mode=1777", "--mount", `type=bind,src=${dir},dst=/acceptance,readonly`,
    "-w", "/tmp", "--entrypoint", "node", image, "--test", "/acceptance/claude-request-budget-cli.test.mjs"],
  { stdio: "inherit", timeout: 240_000 });
} finally {
  try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 }); } catch { /* --rm may already have removed it. */ }
  await rm(dir, { recursive: true, force: true });
}
