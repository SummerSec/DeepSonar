import { createRequire } from "node:module";

// Reuse the scheduler's existing YAML dependency; no new package or action.
const { parse } = createRequire(new URL("../apps/scheduler/package.json", import.meta.url))("yaml");

export function hasChromeArm64Gate(ciWorkflow) {
  const rawNeeds = parse(ciWorkflow)?.jobs?.["chrome-fuzz-arm64"]?.needs;
  const needs = Array.isArray(rawNeeds) ? rawNeeds : [rawNeeds];
  return ciWorkflow.includes("chrome-fuzz-arm64-build:") && ciWorkflow.includes("chrome-fuzz-arm64:") && needs.includes("chrome-fuzz-arm64-build") && ciWorkflow.includes("runs-on: ubuntu-24.04-arm") && ciWorkflow.includes("steps.image.outputs.digest") && ciWorkflow.includes("docker/setup-qemu-action@v3") && ciWorkflow.includes("platforms: linux/arm64") && ciWorkflow.includes('docker pull --platform linux/arm64 "$image_ref"') && ciWorkflow.includes("test-chrome-runtime.mjs") && ciWorkflow.includes("agent-harness/chrome-fuzz-runtime.json linux/arm64");
}
