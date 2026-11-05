import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// #893: publication and bundled writeback are independent stages over one frozen
// payload. These assertions exist because v0.6.6-v0.6.10 each failed exactly where the
// two were chained: a writeback problem withheld the Release.
const require = createRequire(new URL("../apps/scheduler/package.json", import.meta.url));
const yaml = require("yaml");

const release = yaml.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const resume = yaml.parse(readFileSync(new URL("../.github/workflows/release-resume.yml", import.meta.url), "utf8"));

const jobs = release.jobs;
assert.ok(jobs["release-publish"], "release.yml must publish in its own stage");
assert.ok(jobs["release-writeback"], "release.yml must write back in its own stage");
assert.equal(jobs.release, undefined, "the combined release job must be gone");

// 1. A writeback failure cannot withhold the Release.
assert.equal(
  (jobs["release-publish"].needs ?? []).includes("release-writeback"),
  false,
  "publication must not wait for the writeback",
);
assert.equal(jobs["release-writeback"]["continue-on-error"], true,
  "a writeback failure stays visible without invalidating the published Release");

// 2. Both stages consume the same frozen payload and nothing else.
for (const name of ["release-publish", "release-writeback"]) {
  const steps = jobs[name].steps ?? [];
  const downloads = steps.filter((step) => String(step.uses ?? "").startsWith("actions/download-artifact"));
  assert.ok(downloads.length >= 1, `${name} must consume published artifacts`);
  assert.ok(
    downloads.some((step) => step.with?.name === "platform-release-payload"),
    `${name} must read the frozen payload`,
  );
}

// 3. Each stage delegates to the shared, tested script rather than inline shell.
const scriptOf = (name, path) => {
  const steps = jobs[name].steps ?? [];
  return steps.some((step) => String(step.run ?? "").includes(path));
};
assert.ok(scriptOf("release-publish", "release-publish.sh"), "publication uses release-publish.sh");
assert.ok(scriptOf("release-writeback", "release-writeback.sh"), "writeback uses release-writeback.sh");

// 4. The resume entry exists and can run either stage without rebuilding.
const trigger = resume.on?.workflow_dispatch?.inputs ?? {};
for (const key of ["version", "source_run_id", "stages"]) {
  assert.ok(trigger[key], `release-resume must accept ${key}`);
}
assert.deepEqual(trigger.stages.options, ["both", "writeback", "publish"]);
const resumeSteps = resume.jobs?.resume?.steps ?? [];
assert.ok(
  resumeSteps.some((step) => String(step.run ?? "").includes("release-resume.mjs")),
  "resume must reuse the original run's artifacts instead of rebuilding",
);
assert.ok(resumeSteps.some((step) => String(step.run ?? "").includes("release-writeback.sh")));
assert.ok(resumeSteps.some((step) => String(step.run ?? "").includes("release-publish.sh")));
assert.ok(resume.permissions?.["pull-requests"] === "write", "resume needs to merge the writeback PR");

// 5. Neither stage regressed the guard that keeps an existing Release untouched.
const publishScript = readFileSync(new URL("./release-publish.sh", import.meta.url), "utf8");
assert.match(publishScript, /gh release view/u);
assert.match(publishScript, /leaving it untouched/u);
const writebackScript = readFileSync(new URL("./release-writeback.sh", import.meta.url), "utf8");
assert.match(writebackScript, /git diff --cached --quiet/u, "writeback stays idempotent by early exit");
assert.match(writebackScript, /release-writeback\.mjs/u);

// 6. #899: `git checkout -f -B` restores every tracked file to the default branch, so the
// bundled catalog must be captured into a temp BEFORE that checkout. v0.6.12 captured it
// after the checkout, committed only deploy/.env.example and left the catalog a release
// behind. Presence-only assertions cannot see an ordering mistake, so pin the order.
const captureAt = writebackScript.indexOf('cp "$registry_file" "$tmp_registry"');
// Match the command, not the prose that documents the hazard in the file header.
const checkoutAt = writebackScript.search(/^git checkout -f -B "/mu);
assert.ok(captureAt >= 0, "writeback must capture the bundled catalog into a temp file");
assert.ok(checkoutAt >= 0, "writeback must switch to the bot branch");
assert.ok(captureAt < checkoutAt,
  "writeback must capture deploy/runtime-image-registry.json before git checkout -f -B overwrites it (#899)");
assert.ok(writebackScript.indexOf('check-platform-release.mjs --write-env') < checkoutAt,
  "the deployment example must be rewritten from the captured catalog before the checkout");
assert.ok(writebackScript.indexOf('cp "$tmp_registry" "$registry_file"') > checkoutAt,
  "the captured catalog must be restored on top of the bot branch");

console.log("release stages: publication and writeback are independent, resumable and idempotent");
