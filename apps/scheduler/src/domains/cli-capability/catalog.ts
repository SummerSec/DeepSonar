import { createHash } from "node:crypto";
import {
  CAPABILITY_PACK_SCHEMA,
  CapabilityPackDraft,
  CLI_CAPABILITY_SCHEMA,
  CliCapabilityManifest,
  type CliCapabilityManifest as CliManifest,
  type FrozenCliCapability,
  type FrozenCliCapabilityPack,
} from "@deepsonar/shared-types";
import {
  capabilityPackDigest,
  freezeCapabilityPackManifest,
  type CapabilityCatalogRecord,
} from "../capability-pack/catalog.js";

/** Official images that inherit or re-pin base CLI utilities (git/rg/jq/file/unzip/xz + coreutils/tar). */
export const BASE_CLI_COMPATIBLE_IMAGES = [
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-chrome-test",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-fuzz",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-fuzz",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-mobile",
] as const;

const DEFAULT_LIMITS = {
  max_calls_per_job: 128,
  timeout_ms: 60_000,
  max_output_bytes: 1_048_576,
} as const;

const NON_FINDING = [
  "CLI stdout/stderr is Evidence/Fact input only; never a security Finding",
  "Exit code zero does not prove absence of vulnerabilities",
  "Text matches are not semantic / taint / data-flow conclusions",
] as const;

const FAILURE =
  "On tool missing or incompatible image return capability_unavailable; never silently fall back to unregistered shell commands. Truncation and timeouts are inconclusive observations.";

const CLEANUP =
  "Keep workspace-local outputs under the frozen Job workspace; delete ephemeral temp files after retaining evidence hashes and command argv.";

function manualFor(toolId: string): string[] {
  return [
    `agent-harness/runtime-manuals/catalog.json#deepsonar-base/${toolId}`,
    `agent-harness/runtime-manuals/catalog.json#deepsonar-audit/${toolId}`,
  ];
}

function manifest(input: Omit<CliManifest, "schema">): CliManifest {
  return CliCapabilityManifest.parse({ schema: CLI_CAPABILITY_SCHEMA, ...input });
}

/** Authoritative governed catalog for general CLI capability modules (phase 1 / #611). */
export const CLI_CAPABILITY_MANIFESTS: readonly CliManifest[] = [
  manifest({
    id: "text.search.rg",
    version: "1.0.0",
    tool: "rg",
    tool_version: "image-pinned",
    binaries: ["rg"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS },
    common_args: ["--line-number", "--glob", "--type", "--hidden", "-e"],
    evidence_types: ["text_match", "path_list"],
    non_inferable_conclusions: [...NON_FINDING, "rg matches are not AST or type-aware"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: manualFor("ripgrep"),
    summary: "Governed ripgrep text search; Hub proposes text.search.rg, Scheduler freezes; never apt-install search tools.",
    example_invocation: "rg --line-number --glob '!node_modules' 'TODO' /workspace",
  }),
  manifest({
    id: "file.discovery.fd",
    version: "1.0.0",
    tool: "fd",
    tool_version: "image-pinned",
    binaries: ["fd", "fdfind"],
    // Phase-1: registered but not yet apt-pinned in Dockerfile.agent (follow-up: fd-find + symlink).
    compatible_images: [],
    default_available: false,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS },
    common_args: ["--type", "f", "--glob", "--hidden", "--max-depth"],
    evidence_types: ["path_list"],
    non_inferable_conclusions: [...NON_FINDING, "File discovery is not content analysis"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: [
      "docs/CLI_CAPABILITIES.md#filediscoveryfd",
      "agent-harness/runtime-manuals/catalog.json#deepsonar-base/ripgrep",
    ],
    summary: "Governed fd file discovery (phase 1 catalog only; image pin follow-up). Admission returns tool_missing until shipped.",
    example_invocation: "fd --type f --glob '*.ts' /workspace",
  }),
  manifest({
    id: "json.query.jq",
    version: "1.0.0",
    tool: "jq",
    tool_version: "image-pinned",
    binaries: ["jq"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS },
    common_args: ["-e", "-r", "--arg", "."],
    evidence_types: ["json_transform"],
    non_inferable_conclusions: [...NON_FINDING, "Transformed JSON is not the original evidence"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: manualFor("jq"),
    summary: "Governed jq JSON query/transform; output is observation only.",
    example_invocation: "jq -e '.status' result.json",
  }),
  manifest({
    id: "yaml.query.yq",
    version: "1.0.0",
    tool: "yq",
    tool_version: "image-pinned",
    binaries: ["yq"],
    // No mikefarah-style pin in official Debian bookworm; kislyuk yq pin deferred.
    compatible_images: [],
    default_available: false,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS },
    common_args: ["-e", "-r", "-y", "."],
    evidence_types: ["yaml_transform"],
    non_inferable_conclusions: [...NON_FINDING, "YAML transform is not schema validation"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: [
      "docs/CLI_CAPABILITIES.md#yamlqueryyq",
      "agent-harness/runtime-manuals/catalog.json#deepsonar-base/jq",
    ],
    summary: "Governed yq YAML query (phase 1 catalog only; image pin follow-up). Admission returns tool_missing until shipped.",
    example_invocation: "yq -e '.metadata.name' manifest.yaml",
  }),
  manifest({
    id: "source.control.git",
    version: "1.0.0",
    tool: "git",
    tool_version: "image-pinned",
    binaries: ["git"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS, timeout_ms: 120_000 },
    common_args: ["status", "--short", "log", "--oneline", "diff", "rev-parse"],
    evidence_types: ["vcs_state", "diff"],
    non_inferable_conclusions: [...NON_FINDING, "Commit history is provenance, not vulnerability proof"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: manualFor("git"),
    summary: "Governed git for version/commit/diff/history in the frozen workspace.",
    example_invocation: "git status --short",
  }),
  manifest({
    id: "file.inspect.file",
    version: "1.0.0",
    tool: "file",
    tool_version: "image-pinned",
    binaries: ["file"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS, max_calls_per_job: 256 },
    common_args: ["--brief", "--mime-type", "--dereference"],
    evidence_types: ["file_type_hint"],
    non_inferable_conclusions: [...NON_FINDING, "file(1) hints are not format-proof parsers"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: manualFor("file"),
    summary: "Governed file(1) type identification before selecting analyzers.",
    example_invocation: "file --brief artifact.bin",
  }),
  manifest({
    id: "evidence.hash.sha256sum",
    version: "1.0.0",
    tool: "sha256sum",
    tool_version: "image-pinned",
    binaries: ["sha256sum"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS, max_calls_per_job: 512 },
    common_args: ["--check", "--strict", "--tag"],
    evidence_types: ["content_digest"],
    non_inferable_conclusions: [...NON_FINDING, "Digest equality is integrity, not safety"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: ["docs/CLI_CAPABILITIES.md#evidencehashsha256sum"],
    summary: "Governed sha256sum for evidence integrity digests (coreutils on base images).",
    example_invocation: "sha256sum artifact.bin",
  }),
  manifest({
    id: "patch.diff",
    version: "1.0.0",
    tool: "diff",
    tool_version: "image-pinned",
    binaries: ["diff", "patch"],
    // Phase-1: diffutils/patch not yet apt-pinned in Dockerfile.agent (follow-up).
    compatible_images: [],
    default_available: false,
    permissions: ["read_workspace", "write_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS },
    common_args: ["-u", "-N", "-r", "--strip", "-p0", "-p1"],
    evidence_types: ["unified_diff", "patch_apply_receipt"],
    non_inferable_conclusions: [...NON_FINDING, "A clean patch apply is not a security fix verification"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: ["docs/CLI_CAPABILITIES.md#patchdiff"],
    summary: "Governed diff/patch (phase 1 catalog only; image pin follow-up). Admission returns tool_missing until shipped.",
    example_invocation: "diff -u a.txt b.txt",
  }),
  manifest({
    id: "execution.timeout",
    version: "1.0.0",
    tool: "timeout",
    tool_version: "image-pinned",
    binaries: ["timeout"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS, timeout_ms: 300_000 },
    common_args: ["--signal=TERM", "--kill-after=5s", "30s"],
    evidence_types: ["bounded_execution"],
    non_inferable_conclusions: [...NON_FINDING, "Timeout wrap does not change child-tool semantics"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: ["docs/CLI_CAPABILITIES.md#executiontimeout"],
    summary: "Governed timeout(1) to bound command wall time (coreutils on base images).",
    example_invocation: "timeout --signal=TERM 30s rg pattern /workspace",
  }),
  manifest({
    id: "archive.extract",
    version: "1.0.0",
    tool: "tar",
    tool_version: "image-pinned",
    binaries: ["tar", "unzip", "xz", "unxz"],
    compatible_images: [...BASE_CLI_COMPATIBLE_IMAGES],
    default_available: true,
    permissions: ["read_workspace", "write_workspace"],
    network: "disabled",
    limits: { ...DEFAULT_LIMITS, timeout_ms: 180_000, max_output_bytes: 4_194_304 },
    common_args: ["-tf", "-xf", "-C", "-l", "-d", "--decompress", "--keep"],
    evidence_types: ["archive_listing", "extracted_tree"],
    non_inferable_conclusions: [...NON_FINDING, "Archive listing is not malware or vulnerability analysis"],
    failure_policy: FAILURE,
    cleanup: CLEANUP,
    manual_paths: [
      ...manualFor("unzip"),
      ...manualFor("xz-utils"),
    ],
    summary: "Governed tar/unzip/xz archive inspect and extract under the Job workspace.",
    example_invocation: "unzip -l sample.zip",
  }),
];

export const PHASE1_CLI_CAPABILITY_IDS = CLI_CAPABILITY_MANIFESTS.map((m) => m.id) as readonly string[];

function packDraftForCli(module: CliManifest): CapabilityPackDraft {
  const caps = module.permissions.includes("write_workspace")
    ? ["read_workspace", "emit_fact"]
    : ["read_workspace", "emit_fact"];
  return CapabilityPackDraft.parse({
    schema: CAPABILITY_PACK_SCHEMA,
    id: module.id,
    version: module.version,
    scope: "builtin",
    summary: module.summary,
    capabilities: caps,
    inputs: [
      { name: "workspace", schema: "string", required: true },
      { name: "argv", schema: "string[]", required: false },
    ],
    outputs: [{ name: "cli_capability_result", artifact_schema: "cli.capability_result" }],
    permissions: { platform_tools: [], allow_egress: false },
    budget: { max_attempts: 3, max_tokens: 50_000 },
    failure_policy: { correctable: true, replay: "same_session" },
    evaluator: `capability.${module.id}.v1`,
  });
}

export function cliCapabilityPackRecords(): CapabilityCatalogRecord[] {
  return CLI_CAPABILITY_MANIFESTS.map((module) => ({
    manifest: freezeCapabilityPackManifest(packDraftForCli(module)),
    source_kind: "builtin",
  }));
}

export function findCliCapability(id: string): CliManifest | undefined {
  return CLI_CAPABILITY_MANIFESTS.find((module) => module.id === id);
}

export function listCliCapabilities(): CliManifest[] {
  return [...CLI_CAPABILITY_MANIFESTS];
}

export function availableCliCapabilityIdsForImage(imageKey: string): string[] {
  return CLI_CAPABILITY_MANIFESTS
    .filter((m) => m.default_available && m.compatible_images.includes(imageKey))
    .map((m) => m.id);
}

export function cliConfigFingerprint(input: {
  id: string;
  version: string;
  tool: string;
  tool_version: string;
  image_key: string;
  binaries: readonly string[];
  limits?: unknown;
  network: string;
  permissions: readonly string[];
}): string {
  const body = {
    id: input.id,
    version: input.version,
    tool: input.tool,
    tool_version: input.tool_version,
    image_key: input.image_key,
    binaries: [...input.binaries].sort(),
    limits: input.limits ?? null,
    network: input.network,
    permissions: [...input.permissions].sort(),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function freezeCliCapability(input: {
  module: CliManifest;
  imageKey: string;
}): FrozenCliCapability {
  const config_fingerprint = cliConfigFingerprint({
    id: input.module.id,
    version: input.module.version,
    tool: input.module.tool,
    tool_version: input.module.tool_version,
    image_key: input.imageKey,
    binaries: input.module.binaries,
    limits: input.module.limits,
    network: input.module.network,
    permissions: input.module.permissions,
  });
  return {
    schema: CLI_CAPABILITY_SCHEMA,
    id: input.module.id,
    version: input.module.version,
    tool: input.module.tool,
    tool_version: input.module.tool_version,
    image_key: input.imageKey,
    config_fingerprint,
    binaries: [...input.module.binaries],
    limits: { ...input.module.limits },
    network: input.module.network,
    permissions: [...input.module.permissions],
  };
}

export function cliPackFingerprint(frozen: readonly FrozenCliCapability[]): string {
  const body = frozen
    .map((item) => ({
      id: item.id,
      version: item.version,
      image_key: item.image_key,
      config_fingerprint: item.config_fingerprint,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function freezeCliCapabilityPack(input: {
  frozen: readonly FrozenCliCapability[];
  imageKey: string;
}): FrozenCliCapabilityPack {
  return {
    schema: "deepsonar.cli-capability-pack/v1",
    capabilities: [...input.frozen],
    pack_fingerprint: cliPackFingerprint(input.frozen),
    image_key: input.imageKey,
  };
}

export function cliCapabilityPackDigest(id: string): string | undefined {
  const module = findCliCapability(id);
  if (!module) return undefined;
  return capabilityPackDigest(packDraftForCli(module));
}
