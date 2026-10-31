/**
 * OpenSandbox deploy config schema gate (#583).
 *
 * Runs the pinned immutable server image's pydantic `load_config` against a
 * TOML file via `docker run --rm` (bind-mount only). No docker.sock, no
 * sandbox create, no named volumes, no production DB.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENSANDBOX_SERVER_IMAGE,
  assertOpenSandboxImmutableRef,
  readOpenSandboxPin,
} from "./opensandbox-version.js";

const GATE_MARKER = "OPENSANDBOX_CONFIG_SCHEMA_OK";
const LOAD_CONFIG_PY = [
  "from opensandbox_server.config import load_config",
  'load_config("/etc/opensandbox/config.toml")',
  `print("${GATE_MARKER}")`,
].join(";");

const SECRETISH_RE =
  /(?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*["']?[^\s"',}\]]+/gi;
const HOME_PATH_RE = /\/(?:home|Users)\/[^\s"',}\]]+/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+=\/]+/gi;

export type OpenSandboxSchemaGateSkipReason =
  | "docker_cli_missing"
  | "docker_daemon_unavailable"
  | "forced_skip";

export type OpenSandboxSchemaGateProbe = {
  available: boolean;
  skipReason?: OpenSandboxSchemaGateSkipReason;
  detail?: string;
};

export type OpenSandboxSchemaGateResult = {
  ok: boolean;
  image: string;
  configPath: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  redactedError: string;
};

export function repoRootFromHere(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "../../..");
}

export function opensandboxConfigFixturePath(name: string, moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "fixtures/opensandbox-config", name);
}

/** Single source of truth: opensandbox-version.ts pin (no second drifting ref). */
export function pinnedOpenSandboxServerImage(): string {
  const pin = readOpenSandboxPin({ serverImage: OPENSANDBOX_SERVER_IMAGE });
  return assertOpenSandboxImmutableRef(pin.serverImage, "server");
}

export function redactOpenSandboxSchemaError(raw: string): string {
  return raw
    .replace(SECRETISH_RE, (match) => {
      const sep = match.includes("=") ? "=" : ":";
      const key = match.split(/[=:]/, 1)[0];
      return `${key.trim()}${sep}<redacted>`;
    })
    .replace(BEARER_RE, "Bearer <redacted>")
    .replace(HOME_PATH_RE, "<redacted-home-path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function dockerBin(): string {
  return process.env.OPENSANDBOX_SCHEMA_GATE_DOCKER?.trim() || "docker";
}

export function probeOpenSandboxSchemaGateDocker(): OpenSandboxSchemaGateProbe {
  if (process.env.OPENSANDBOX_SCHEMA_GATE_SKIP === "1") {
    return { available: false, skipReason: "forced_skip", detail: "OPENSANDBOX_SCHEMA_GATE_SKIP=1" };
  }
  const bin = dockerBin();
  const version = spawnSync(bin, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { available: false, skipReason: "docker_cli_missing", detail: `${bin} not found` };
  }
  if (version.status !== 0) {
    const detail = redactOpenSandboxSchemaError(
      `${version.stderr || ""}\n${version.stdout || ""}`.trim() || `docker exit ${version.status}`,
    );
    return { available: false, skipReason: "docker_daemon_unavailable", detail };
  }
  return { available: true };
}

export function schemaGateRequiredInThisEnvironment(): boolean {
  return process.env.CI === "true"
    || process.env.OPENSANDBOX_SCHEMA_GATE_REQUIRED === "1";
}

function formatGateFailure(result: OpenSandboxSchemaGateResult): string {
  return [
    "OPENSANDBOX_CONFIG_SCHEMA_GATE_FAILED",
    `image=${result.image}`,
    `config=${result.configPath}`,
    `exit=${result.exitCode ?? "null"}`,
    `error=${result.redactedError || "(empty)"}`,
  ].join(" ");
}

/**
 * Parse config.toml with the pinned OpenSandbox server image schema.
 * Uses docker run --rm + read-only bind mount; leaves no container/volume behind.
 */
export function parseOpenSandboxConfigWithPinnedImage(
  configPath: string,
  options: { image?: string; pullIfMissing?: boolean } = {},
): OpenSandboxSchemaGateResult {
  const image = assertOpenSandboxImmutableRef(
    options.image ?? pinnedOpenSandboxServerImage(),
    "server",
  );
  const absoluteConfig = resolve(configPath);
  accessSync(absoluteConfig, fsConstants.R_OK);

  const bin = dockerBin();
  if (options.pullIfMissing !== false) {
    const inspect = spawnSync(bin, ["image", "inspect", image], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (inspect.status !== 0) {
      const pull = spawnSync(bin, ["pull", image], {
        encoding: "utf8",
        timeout: 300_000,
      });
      if (pull.status !== 0) {
        const combined = `${pull.stderr || ""}\n${pull.stdout || ""}`.trim();
        const redactedError = redactOpenSandboxSchemaError(combined || `docker pull exit ${pull.status}`);
        return {
          ok: false,
          image,
          configPath: absoluteConfig,
          exitCode: pull.status,
          stdout: pull.stdout || "",
          stderr: pull.stderr || "",
          combined,
          redactedError,
        };
      }
    }
  }

  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${absoluteConfig}:/etc/opensandbox/config.toml:ro`,
    "--entrypoint",
    "python",
    image,
    "-c",
    LOAD_CONFIG_PY,
  ];
  const run = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      // Never leak host API keys into the validator container.
      OPENSANDBOX_SERVER_API_KEY: "",
      OPEN_SANDBOX_API_KEY: "",
    },
  });

  const stdout = run.stdout || "";
  const stderr = run.stderr || "";
  const combined = `${stderr}\n${stdout}`.trim();
  const ok = run.status === 0 && stdout.includes(GATE_MARKER);
  const redactedError = ok
    ? ""
    : redactOpenSandboxSchemaError(combined || `docker run exit ${run.status}`);

  return {
    ok,
    image,
    configPath: absoluteConfig,
    exitCode: run.status,
    stdout,
    stderr,
    combined,
    redactedError,
  };
}

export function assertOpenSandboxConfigSchemaPasses(configPath: string): OpenSandboxSchemaGateResult {
  const result = parseOpenSandboxConfigWithPinnedImage(configPath);
  if (!result.ok) {
    throw new Error(formatGateFailure(result));
  }
  return result;
}

export function assertOpenSandboxConfigSchemaFails(
  configPath: string,
  expectedErrorFragment: RegExp | string,
): OpenSandboxSchemaGateResult {
  const result = parseOpenSandboxConfigWithPinnedImage(configPath);
  if (result.ok) {
    throw new Error(
      `OPENSANDBOX_CONFIG_SCHEMA_GATE_UNEXPECTED_PASS image=${result.image} config=${result.configPath}`,
    );
  }
  const needle = typeof expectedErrorFragment === "string"
    ? expectedErrorFragment
    : expectedErrorFragment.source;
  const haystack = result.combined;
  const matched = typeof expectedErrorFragment === "string"
    ? haystack.includes(expectedErrorFragment)
    : expectedErrorFragment.test(haystack);
  if (!matched) {
    throw new Error(
      [
        "OPENSANDBOX_CONFIG_SCHEMA_GATE_UNEXPECTED_ERROR",
        `image=${result.image}`,
        `config=${result.configPath}`,
        `expected=${needle}`,
        `error=${result.redactedError || "(empty)"}`,
      ].join(" "),
    );
  }
  return result;
}

/** Lightweight structural check for K8s gateway required fields (no docker). */
export function assertKubernetesGatewayTomlHasRequiredFields(toml: string, label: string): void {
  const ingress = toml.match(/\[ingress\]([\s\S]*?)(?=\n\[|$)/);
  if (!ingress) {
    throw new Error(`${label}: missing [ingress]`);
  }
  if (!/mode\s*=\s*"gateway"/.test(ingress[1])) {
    throw new Error(`${label}: expected ingress.mode = "gateway"`);
  }
  if (!/\[ingress\.gateway\]/.test(toml)) {
    throw new Error(`${label}: gateway mode requires [ingress.gateway]`);
  }
  const gateway = toml.match(/\[ingress\.gateway\]([\s\S]*?)(?=\n\[|$)/);
  if (!gateway) {
    throw new Error(`${label}: missing [ingress.gateway] body`);
  }
  if (!/^\s*address\s*=\s*"[^"]+"/m.test(gateway[1])) {
    throw new Error(`${label}: ingress.gateway.address is required`);
  }
  if (!/\[ingress\.gateway\.route\]/.test(toml)) {
    throw new Error(`${label}: gateway mode requires [ingress.gateway.route]`);
  }
  const route = toml.match(/\[ingress\.gateway\.route\]([\s\S]*?)(?=\n\[|$)/);
  if (!route || !/^\s*mode\s*=\s*"(wildcard|header|uri)"/m.test(route[1])) {
    throw new Error(`${label}: ingress.gateway.route.mode is required`);
  }
}

export function assertDockerIngressIsDirect(toml: string, label: string): void {
  const ingress = toml.match(/\[ingress\]([\s\S]*?)(?=\n\[|$)/);
  if (!ingress) {
    throw new Error(`${label}: missing [ingress]`);
  }
  if (!/mode\s*=\s*"direct"/.test(ingress[1])) {
    throw new Error(`${label}: Docker default must keep ingress.mode = "direct"`);
  }
  if (/mode\s*=\s*"gateway"/.test(ingress[1])) {
    throw new Error(`${label}: Docker default must not use ingress.mode = "gateway"`);
  }
}
