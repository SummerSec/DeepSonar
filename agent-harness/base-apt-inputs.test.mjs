import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { aptSources, verifyAptLists, verifyAptMetadata } from "./base-apt-inputs.mjs";

const frozen = JSON.parse(readFileSync(new URL("./base-apt-runtime.json", import.meta.url), "utf8"));
const body = new TextEncoder().encode("Signed InRelease fixture\n");
const digest = createHash("sha256").update(body).digest("hex");
const fixture = () => ({ ...frozen, inReleases: Object.fromEntries(Object.keys(frozen.inReleases).map(suite => [suite, digest])) });

test("base APT uses only the checked snapshot, signed InRelease inputs and no live mirror", () => {
  const sources = aptSources(frozen);
  assert.equal((sources.match(/Types: deb/gu) ?? []).length, 3);
  assert.equal((sources.match(/Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring.gpg/gu) ?? []).length, 3);
  assert.equal((sources.match(/Check-Valid-Until: no/gu) ?? []).length, 3);
  for (const suite of Object.keys(frozen.inReleases)) assert.ok(sources.includes(`Suites: ${suite}\n`));
  assert.ok(sources.includes(`/archive/debian/${frozen.snapshot}/`));
  assert.ok(sources.includes(`/archive/debian-security/${frozen.snapshot}/`));
  assert.ok(!sources.includes("deb.debian.org"));
});

test("base APT rejects missing, injected, extra, old and unpinned inputs", () => {
  for (const input of [null, {}, { ...frozen, snapshot: "../live" },
    { ...frozen, uri: "https://127.0.0.1" },
    { snapshot: frozen.snapshot, releases: frozen.inReleases },
    { ...frozen, inReleases: { bookworm: digest } },
    { ...frozen, inReleases: { ...frozen.inReleases, other: digest } },
    { ...frozen, inReleases: { ...frozen.inReleases, bookworm: "latest" } },
    { ...frozen, inReleases: { ...frozen.inReleases, bookworm: digest.toUpperCase() } }]) {
    assert.throws(() => aptSources(input), /APT_SNAPSHOT_INPUT_INVALID/u);
  }
});

test("base APT checks all three actual InRelease byte hashes before configuration", async () => {
  const requests = [];
  await verifyAptMetadata(fixture(), async (url, options) => {
    requests.push(url);
    assert.equal(options.signal.aborted, false);
    return { ok: true, arrayBuffer: async () => body.buffer };
  });
  assert.equal(requests.length, 3);
  assert.ok(requests[0].endsWith(`/archive/debian/${frozen.snapshot}/dists/bookworm/InRelease`));
  assert.ok(requests[1].endsWith(`/archive/debian/${frozen.snapshot}/dists/bookworm-updates/InRelease`));
  assert.ok(requests[2].endsWith(`/archive/debian-security/${frozen.snapshot}/dists/bookworm-security/InRelease`));
});

test("base APT rejects changed or missing metadata actually consumed after a successful precheck", async () => {
  await verifyAptMetadata(fixture(), async () => ({ ok: true, arrayBuffer: async () => body.buffer }));
  const paths = [];
  verifyAptLists(fixture(), filename => { paths.push(filename); return body; });
  assert.deepEqual(paths, [
    `/var/lib/apt/lists/snapshot.debian.org_archive_debian_${frozen.snapshot}_dists_bookworm_InRelease`,
    `/var/lib/apt/lists/snapshot.debian.org_archive_debian_${frozen.snapshot}_dists_bookworm-updates_InRelease`,
    `/var/lib/apt/lists/snapshot.debian.org_archive_debian-security_${frozen.snapshot}_dists_bookworm-security_InRelease`,
  ]);
  assert.throws(() => verifyAptLists(fixture(), filename => filename.endsWith("_bookworm-security_InRelease") ? Buffer.from("changed") : body), /APT_INRELEASE_IDENTITY_MISMATCH: bookworm-security/u);
  assert.throws(() => verifyAptLists(fixture(), () => { throw new Error("ENOENT"); }), /APT_INRELEASE_UNAVAILABLE: bookworm/u);
});

test("base APT hash or transport rejection never tries a live mirror", async () => {
  let calls = 0;
  await assert.rejects(verifyAptMetadata(fixture(), async () => {
    calls += 1;
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode("changed").buffer };
  }), /APT_INRELEASE_IDENTITY_MISMATCH: bookworm/u);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(verifyAptMetadata(fixture(), async () => {
    calls += 1;
    return { ok: false, status: 503 };
  }), /APT_SNAPSHOT_UNAVAILABLE: bookworm HTTP 503/u);
  assert.equal(calls, 1);
});

test("base CLI and OM locks cover the full npm graph and retain declared root/SDK identities", () => {
  const docker = readFileSync(new URL("../deploy/Dockerfile.agent", import.meta.url), "utf8");
  const arg = name => docker.match(new RegExp(`^ARG ${name}=(.+)$`, "m"))?.[1];
  for (const [directory, roots] of [
    ["base-cli-runtime", [["@anthropic-ai/claude-code", "CLAUDE_CODE"], ["@earendil-works/pi-coding-agent", "PI_CODING_AGENT"]]],
    ["pi-extensions-base-runtime", [["pi-observational-memory", "PI_OBSERVATIONAL_MEMORY"]]],
  ]) {
    const manifest = JSON.parse(readFileSync(new URL(`./${directory}/package.json`, import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL(`./${directory}/package-lock.json`, import.meta.url), "utf8"));
    assert.equal(manifest.private, true);
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
    for (const [name, prefix] of roots) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.equal(manifest.dependencies[name], arg(`${prefix}_VERSION`), name);
      assert.equal(entry.version, arg(`${prefix}_VERSION`), name);
      assert.equal(entry.integrity, arg(`${prefix}_INTEGRITY`), name);
    }
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (!name) continue;
      assert.ok(entry.resolved.startsWith("https://registry.npmjs.org/"), name);
      assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, name);
      assert.equal(Buffer.from(entry.integrity.slice(7), "base64").length, 64, name);
    }
    for (const name of ["pi-agent-core", "pi-ai", "pi-tui"]) {
      assert.equal(lock.packages[`node_modules/@earendil-works/${name}`].version, arg("PI_CODING_AGENT_VERSION"));
    }
  }
  for (const name of ["FD_AMD64_SHA256", "FD_ARM64_SHA256"]) assert.match(arg(name), /^[a-f0-9]{64}$/u);
  const [major, minor] = arg("FD_VERSION").split(".").map(Number);
  assert.ok(major > 8 || (major === 8 && minor >= 7), "Pi find requires --no-require-git");
});
