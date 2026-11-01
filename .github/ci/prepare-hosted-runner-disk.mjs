import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These are preinstalled SDK/toolchain trees that the Chrome Fuzz Docker build
// does not consume. Keep this list explicit: workspace, runner, and Docker
// state must never be selected dynamically for deletion.
export const REMOVABLE_PATHS = Object.freeze([
  "/usr/local/lib/android",
  "/usr/share/dotnet",
  "/opt/ghc",
  "/usr/local/share/boost",
  "/usr/share/swift",
  "/usr/local/.ghcup",
  "/opt/hostedtoolcache/CodeQL",
  "/opt/hostedtoolcache/go",
  "/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk",
]);

const PROTECTED_PATHS = Object.freeze([
  "/home/runner/work",
  "/home/runner/_work",
  "/home/runner/.docker",
  "/var/lib/docker",
  "/var/lib/containerd",
  "/run/docker",
  "/run/containerd",
]);

function defaultRun(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeAbsolutePath(value) {
  return path.posix.resolve(value);
}

function isPathWithin(child, parent) {
  const normalizedChild = normalizeAbsolutePath(child);
  const normalizedParent = normalizeAbsolutePath(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

export function assertHostedRunner(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error(
      "refusing hosted-runner disk preparation: requires GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted",
    );
  }
}

export function validateAllowlist(env = process.env) {
  const protectedPaths = [
    ...PROTECTED_PATHS,
    env.GITHUB_WORKSPACE,
    env.RUNNER_WORKSPACE,
    env.RUNNER_TEMP,
  ].filter(Boolean);

  for (const removablePath of REMOVABLE_PATHS) {
    if (!removablePath.startsWith("/") || removablePath.includes("\\") || removablePath.includes("/../")) {
      throw new Error(`invalid disk cleanup allowlist path: ${removablePath}`);
    }
    if (protectedPaths.some((protectedPath) => isPathWithin(removablePath, protectedPath) || isPathWithin(protectedPath, removablePath))) {
      throw new Error(`disk cleanup allowlist overlaps protected runner data: ${removablePath}`);
    }
  }
}

function diskDiagnostics(label, run, logger) {
  logger(`::group::Hosted runner disk diagnostics (${label})`);
  try {
    const output = run("df", ["-hP", "/"]);
    if (output) logger(String(output).trimEnd());
  } finally {
    logger("::endgroup::");
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function prepareHostedRunnerDisk({
  env = process.env,
  dryRun = env.DISK_PREP_DRY_RUN === "1",
  run = defaultRun,
  logger = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!dryRun) assertHostedRunner(env);
  validateAllowlist(env);

  const failures = [];
  const removed = [];

  try {
    diskDiagnostics("before", run, logger);
  } catch (error) {
    failures.push(`before diagnostics: ${errorMessage(error)}`);
  }

  if (failures.length === 0) {
    for (const removablePath of REMOVABLE_PATHS) {
      logger(`disk cleanup allowlist: ${removablePath}`);
      if (dryRun) {
        logger(`dry-run: would run sudo rm -rf -- ${removablePath}`);
        continue;
      }

      try {
        run("sudo", ["rm", "-rf", "--", removablePath]);
        removed.push(removablePath);
      } catch (error) {
        failures.push(`remove ${removablePath}: ${errorMessage(error)}`);
        break;
      }
    }
  }

  try {
    diskDiagnostics("after", run, logger);
  } catch (error) {
    failures.push(`after diagnostics: ${errorMessage(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`hosted-runner disk preparation failed: ${failures.join("; ")}`);
  }

  logger(
    dryRun
      ? "hosted-runner disk preparation dry-run complete; no paths were removed"
      : `hosted-runner disk preparation complete; processed ${removed.length} allowlisted paths`,
  );
  return { dryRun, removed };
}

function parseArgs(argv) {
  let dryRun = process.env.DISK_PREP_DRY_RUN === "1";
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help") {
      process.stdout.write("Usage: node .github/ci/prepare-hosted-runner-disk.mjs [--dry-run]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun };
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (currentFile === invokedFile) {
  try {
    prepareHostedRunnerDisk(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`::error title=Hosted runner disk preparation::${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
