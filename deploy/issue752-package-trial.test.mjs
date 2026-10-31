import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packageTrial, trialEnvExample } from "./issue752-package-trial.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = "a".repeat(40);

test("offline bundle binds every image archive and ID to the full branch SHA", async () => {
  const out = mkdtempSync(join(os.tmpdir(), "issue752-package-"));
  try {
    mkdirSync(join(out, "images"));
    for (const component of ["scheduler", "web", "image-admission"]) {
      writeFileSync(join(out, "images", `deepsonar-${component}.tar`), `archive-${component}`);
      writeFileSync(join(out, "images", `deepsonar-${component}.id`), `sha256:${"b".repeat(64)}\n`);
    }
    const metadata = await packageTrial(repoRoot, out, sha);
    assert.equal(metadata.source_sha, sha);
    assert.equal(metadata.architecture, "linux/amd64");
    assert.equal(metadata.delivery, "actions-artifact-only");
    assert.equal(metadata.images.length, 3);
    assert.ok(metadata.images.every((item) => item.image.endsWith(`:issue752-${sha}`)));
    const lines = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.ok(lines.length > 7, "checksums must also bind the deployment reference files");
    for (const line of lines) {
      const [, expected, relative] = /^([a-f0-9]{64})  (.+)$/.exec(line) ?? [];
      assert.ok(expected && relative);
      const actual = createHash("sha256").update(readFileSync(join(out, relative))).digest("hex");
      assert.equal(actual, expected);
    }
    assert.match(readFileSync(join(out, "deployment", "deploy", ".env.example"), "utf8"), /POSTGRES_BIND=127\.0\.0\.1:55432/);
    const deploy = join(out, "deployment", "deploy");
    copyFileSync(join(deploy, ".env.example"), join(deploy, ".env"));
    writeFileSync(join(deploy, "master.key"), "0".repeat(64));
    execFileSync("docker", ["compose", "-p", "issue752-trial", "--env-file", "deploy/.env",
      "-f", "deploy/docker-compose.prod.yml", "-f", "deploy/docker-compose.real.yml",
      "-f", "deploy/docker-compose.opensandbox.prod.yml", "-f", "deploy/issue752-trial.override.yml",
      "config", "--quiet"], { cwd: join(out, "deployment"), stdio: "pipe" });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("bundle fails closed when a saved image is absent or its ID is malformed", async () => {
  const out = mkdtempSync(join(os.tmpdir(), "issue752-package-invalid-"));
  try {
    mkdirSync(join(out, "images"));
    writeFileSync(join(out, "images", "deepsonar-scheduler.tar"), "nonempty");
    writeFileSync(join(out, "images", "deepsonar-scheduler.id"), "sha256:invalid\n");
    await assert.rejects(() => packageTrial(repoRoot, out, sha), /invalid Docker image ID/);
    assert.throws(() => trialEnvExample("not-a-commit"), /full lowercase commit SHA/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("trial workflow cannot publish before checks and live authorization", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/issue-752-trial.yml"), "utf8");
  assert.match(workflow, /branches: \[codex\/issue-752-project-knowledge\]/);
  assert.match(workflow, /needs: \[checks, live-authorization\]/);
  assert.match(workflow, /include-hidden-files: true/, "the offline bundle must retain deployment/deploy/.env.example");
  assert.match(workflow, /project-knowledge-job\.e2e\.ts/);
  assert.match(workflow, /pnpm --filter @deepsonar\/scheduler exec tsx/);
  assert.match(workflow, /docker save --output/);
  assert.doesNotMatch(workflow, /docker push|build-push-action|create-release|gh release/);
});
