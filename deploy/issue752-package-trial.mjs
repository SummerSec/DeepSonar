import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const components = ["scheduler", "web", "image-admission"];
const referenceFiles = [
  "deploy/docker-compose.prod.yml",
  "deploy/docker-compose.real.yml",
  "deploy/docker-compose.opensandbox.prod.yml",
  "deploy/issue752-trial.override.yml",
  "deploy/opensandbox/config.toml",
  "deploy/opensandbox/dockerenv",
  "deploy/runtime-image-registry.json",
  "database/schema.sql",
  "apps/scheduler/src/schema-version.ts",
  "docs/ISSUE_752_TRIAL.md",
];

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function trialEnvExample(sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("source SHA must be a full lowercase commit SHA");
  return `# Dedicated, empty Linux test host only. Copy to deploy/.env and replace all change-me values.
POSTGRES_PASSWORD=change-me-postgres-password
DEEPSONAR_ADMIN_TOKEN=change-me-bootstrap-token
BLOB_S3_ACCESS_KEY_ID=change-me-silo-access
BLOB_S3_SECRET_ACCESS_KEY=change-me-silo-secret
OPEN_SANDBOX_API_KEY=change-me-opensandbox-key
DEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key
DEEPSONAR_IMAGE_REGISTRY=issue752
DEEPSONAR_IMAGE_TAG=issue752-${sourceSha}
DEEPSONAR_GIT_REVISION=${sourceSha}
AGENT_MODE=real
SANDBOX_PROVIDER=opensandbox
POSTGRES_BIND=127.0.0.1:55432
DEEPSONAR_WEB_PORT=18080
SILO_API_BIND=127.0.0.1:19000
SILO_CONSOLE_BIND=127.0.0.1:19001
OPEN_SANDBOX_HOST_PORT=28081
OPEN_SANDBOX_CONTAINER_NAME=issue752-opensandbox
DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME=issue752-gateway-upstream
DEEPSONAR_IMAGE_SCAN_VOLUME=issue752-admission-scan
ISSUE752_ADMISSION_VOLUME=issue752-admission-scan
ISSUE752_BUSINESS_NETWORK=issue752-business
DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE=docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23
DEEPSONAR_DOCKER_SOCK=/var/run/docker.sock
DEEPSONAR_HOST_DISK_SOURCE=/var/lib/docker
# Before real Job tests, set immutable official runtime image digests from the approved registry.
DEEPSONAR_OFFICIAL_BASE_IMAGE=
DEEPSONAR_OFFICIAL_AUDIT_IMAGE=
DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE=
DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=ghcr.io,docker.io,registry-1.docker.io,crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com
`;
}

/** Verify saved images, then produce a self-contained reference bundle (no startup). */
export async function packageTrial(repoRoot, outputDir, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("source SHA must be a full lowercase commit SHA");
  const root = resolve(repoRoot), out = resolve(outputDir);
  const images = [];
  for (const component of components) {
    const archive = `images/deepsonar-${component}.tar`;
    const archivePath = join(out, archive);
    const id = readFileSync(join(out, `images/deepsonar-${component}.id`), "utf8").trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`${component}: invalid Docker image ID`);
    const bytes = statSync(archivePath).size;
    if (bytes <= 0) throw new Error(`${component}: empty Docker archive`);
    images.push({ component, image: `issue752/deepsonar-${component}:issue752-${sourceSha}`,
      image_id: id, archive, archive_sha256: await digest(archivePath), bytes });
  }
  for (const relative of referenceFiles) {
    const destination = join(out, "deployment", relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, relative), destination);
  }
  const envPath = join(out, "deployment", "deploy", ".env.example");
  writeFileSync(envPath, trialEnvExample(sourceSha), { mode: 0o600 });
  const metadata = { schema: "deepsonar.issue752-trial/v1", source_sha: sourceSha,
    source_branch: "codex/issue-752-project-knowledge", architecture: "linux/amd64",
    delivery: "actions-artifact-only", images };
  writeFileSync(join(out, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  const checksums = [];
  for (const image of images) {
    checksums.push(`${image.archive_sha256}  ${image.archive}`);
    checksums.push(`${await digest(join(out, `images/deepsonar-${image.component}.id`))}  images/deepsonar-${image.component}.id`);
  }
  checksums.push(`${await digest(join(out, "metadata.json"))}  metadata.json`);
  for (const relative of referenceFiles) {
    const path = `deployment/${relative}`;
    checksums.push(`${await digest(join(out, path))}  ${path}`);
  }
  checksums.push(`${await digest(envPath)}  deployment/deploy/.env.example`);
  writeFileSync(join(out, "SHA256SUMS"), checksums.join("\n") + "\n");
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out"), shaIndex = args.indexOf("--source-sha");
  if (outIndex < 0 || shaIndex < 0 || !args[outIndex + 1] || !args[shaIndex + 1]) {
    throw new Error("usage: node deploy/issue752-package-trial.mjs --out DIR --source-sha FULL_SHA");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const metadata = await packageTrial(repoRoot, args[outIndex + 1], args[shaIndex + 1]);
  process.stdout.write(`Packaged ${metadata.images.length} ${metadata.architecture} trial images for ${metadata.source_sha}\n`);
}
