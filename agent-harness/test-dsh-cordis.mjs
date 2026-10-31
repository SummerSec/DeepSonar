import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const image = process.argv[2] ?? process.env.DEEPSONAR_DSH_IMAGE ?? "deepsonar-base:ci";
const source = fileURLToPath(new URL("./", import.meta.url));
// Both the mock provider and official CLI run inside the network-isolated
// container. No model credentials, host gateway or external endpoint is used.
execFileSync("docker", [
  "run", "--rm", "--network", "none", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
  "-v", `${source}:/tmp/deepsonar-dsh-smoke:ro`, image,
  "node", "/tmp/deepsonar-dsh-smoke/dsh-sdk-smoke-driver.mjs",
], { stdio: "inherit", timeout: 90_000 });
