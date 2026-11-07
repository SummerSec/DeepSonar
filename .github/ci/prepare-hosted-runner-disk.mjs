import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These are preinstalled SDK/toolchain trees that the Chrome Fuzz and Reverse Docker builds
// do not consume. Keep this list explicit: workspace, runner, and Docker
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

// Provisional, configurable free-space budget for the hosted runner. 86 GiB is
// an empirical safety margin only -- it is NOT a validated build-peak
// requirement. Re-measure the real Chrome Fuzz / Reverse Docker build disk peak
// on hosted runners before treating this as a hard threshold. Override it via
// DISK_PREP_MIN_FREE_BYTES or --min-free-bytes.
export const MIN_FREE_BYTES = 86 * 1024 ** 3;

// Name of the environment variable used to override MIN_FREE_BYTES (bytes).
export const DISK_PREP_MIN_FREE_BYTES = "DISK_PREP_MIN_FREE_BYTES";

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

function parseMinFreeValue(raw, source) {
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid ${source}: expected a non-negative integer number of bytes, got "${text}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${source}: value is out of the safe integer range: "${text}"`);
  }
  return value;
}

function resolveMinFreeBytes(env) {
  const raw = env[DISK_PREP_MIN_FREE_BYTES];
  // Fail closed: any present-but-invalid value (including "", negatives, or
  // non-integers) is rejected rather than silently degrading to 0 / default.
  return raw === undefined ? MIN_FREE_BYTES : parseMinFreeValue(raw, DISK_PREP_MIN_FREE_BYTES);
}

// Parse the "Available" column (4th field, in 1024-byte blocks) from the
// second line of `df -Pk /` output. -h human-readable units are deliberately
// not accepted; a parse failure throws instead of returning a 0 fallback that
// would let cleanup continue on bad data.
export function parseDfAvailableBytes(output) {
  const lines = String(output).split("\n").filter((line) => line.trim().length > 0);
  const dataLine = lines[1];
  if (!dataLine) {
    throw new Error("cannot parse df available bytes: missing data row in df -Pk output");
  }
  const availableKbText = dataLine.trim().split(/\s+/)[3];
  if (!/^\d+$/.test(availableKbText ?? "")) {
    throw new Error(`cannot parse df available bytes: unexpected available column "${availableKbText}" in "${dataLine}"`);
  }
  const availableKb = Number(availableKbText);
  if (!Number.isSafeInteger(availableKb)) {
    throw new Error(`cannot parse df available bytes: available column out of safe integer range: "${availableKbText}"`);
  }
  const bytes = availableKb * 1024;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`cannot parse df available bytes: byte value out of safe integer range: "${availableKbText}"`);
  }
  return bytes;
}

export function readAvailableBytes(run) {
  return parseDfAvailableBytes(run("df", ["-Pk", "/"]));
}

function formatBytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB (${bytes} bytes)`;
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
  minFreeBytes,
  run = defaultRun,
  logger = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!dryRun) assertHostedRunner(env);
  validateAllowlist(env);

  // Resolve the budget before touching the filesystem. Invalid overrides fail
  // closed here, so no diagnostics or deletions are attempted.
  const minFree = minFreeBytes === undefined
    ? resolveMinFreeBytes(env)
    : parseMinFreeValue(minFreeBytes, "--min-free-bytes");

  const failures = [];
  try {
    diskDiagnostics("before", run, logger);
  } catch (error) {
    failures.push(`before diagnostics: ${errorMessage(error)}`);
  }

  // A failed parse must abort: never fall back to 0 and continue deleting.
  const beforeBytes = readAvailableBytes(run);
  logger(
    `disk prep budget: threshold=${minFree} bytes (${formatBytes(minFree)}); ` +
    `available before=${beforeBytes} bytes (${formatBytes(beforeBytes)})`,
  );

  if (beforeBytes >= minFree) {
    const reason =
      `available ${beforeBytes} bytes (${formatBytes(beforeBytes)}) already meets the ` +
      `min free threshold ${minFree} bytes (${formatBytes(minFree)}); skipping cleanup`;
    logger(`disk prep skip: ${reason}`);
    logger(`disk prep budget: available after=${beforeBytes} bytes (unchanged, cleanup skipped)`);
    return {
      dryRun,
      removed: [],
      skipped: true,
      reason,
      beforeBytes,
      afterBytes: beforeBytes,
      minFreeBytes: minFree,
      steps: [],
    };
  }

  const removed = [];
  const steps = [];
  let afterBytes = beforeBytes;
  let reached = false;

  if (failures.length === 0) {
    for (const removablePath of REMOVABLE_PATHS) {
      logger(`disk cleanup allowlist: ${removablePath}`);
      if (dryRun) {
        logger(`dry-run: would run sudo rm -rf -- ${removablePath}`);
        continue;
      }

      const start = Date.now();
      try {
        run("sudo", ["rm", "-rf", "--", removablePath]);
      } catch (error) {
        failures.push(`remove ${removablePath}: ${errorMessage(error)}`);
        break;
      }
      removed.push(removablePath);

      let availableBytes;
      try {
        availableBytes = readAvailableBytes(run);
      } catch (error) {
        failures.push(`measure available bytes after removing ${removablePath}: ${errorMessage(error)}`);
        break;
      }
      const durationMs = Date.now() - start;
      logger(
        `disk prep step: removed ${removablePath}; ` +
        `available now=${availableBytes} bytes (${formatBytes(availableBytes)}); ` +
        `threshold=${minFree} bytes; duration=${durationMs}ms`,
      );
      steps.push({ path: removablePath, durationMs, availableBytes });
      afterBytes = availableBytes;
      if (availableBytes >= minFree) {
        reached = true;
        break; // budget met: stop, do not delete extra allowlisted paths
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

  logger(`disk prep budget: available after=${afterBytes} bytes (${formatBytes(afterBytes)})`);

  if (!dryRun && afterBytes < minFree) {
    throw new Error(
      `hosted-runner disk preparation failed: insufficient free space after removing all allowlisted paths: ` +
      `available ${afterBytes} bytes (${formatBytes(afterBytes)}) is below the min free threshold ` +
      `${minFree} bytes (${formatBytes(minFree)}); minFreeBytes=${minFree} ` +
      `(override with ${DISK_PREP_MIN_FREE_BYTES} / --min-free-bytes)`,
    );
  }

  const reason = dryRun
    ? `dry-run: simulated cleanup for ${REMOVABLE_PATHS.length} allowlisted paths without removing them; free space not verified as sufficient`
    : reached
      ? `reached min free threshold after removing ${removed.length} allowlisted path(s)`
      : `processed ${removed.length} allowlisted path(s)`;

  logger(
    dryRun
      ? "hosted-runner disk preparation dry-run complete; no paths were removed"
      : `hosted-runner disk preparation complete; ${reason}`,
  );

  return {
    dryRun,
    removed,
    skipped: false,
    reason,
    beforeBytes,
    afterBytes,
    minFreeBytes: minFree,
    steps,
  };
}

function parseArgs(argv) {
  let dryRun = process.env.DISK_PREP_DRY_RUN === "1";
  let minFreeBytes;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help") {
      process.stdout.write(
        "Usage: node .github/ci/prepare-hosted-runner-disk.mjs [--dry-run] [--min-free-bytes <n>]\n" +
        "\n" +
        "Clean the hosted runner disk only until a free-space budget is met.\n" +
        "\n" +
        "Options:\n" +
        "  --dry-run              Simulate cleanup; never invokes sudo.\n" +
        "  --min-free-bytes <n>   Override the free-space budget, in bytes.\n" +
        "  --help                 Show this help and exit.\n" +
        "\n" +
        "Environment:\n" +
        `  ${DISK_PREP_MIN_FREE_BYTES}=<n>   Free-space budget in bytes (default ${MIN_FREE_BYTES}, i.e. 86 GiB).\n` +
        "  DISK_PREP_DRY_RUN=1          Enable dry-run mode.\n" +
        "\n" +
        `The default ${MIN_FREE_BYTES}-byte budget is a provisional, configurable safety\n` +
        "margin, NOT a validated build-peak requirement; re-verify it against real\n" +
        "Chrome Fuzz / Reverse Docker build peaks on hosted runners.\n",
      );
      process.exit(0);
    } else if (arg === "--min-free-bytes") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--min-free-bytes requires a value");
      }
      minFreeBytes = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, minFreeBytes };
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
