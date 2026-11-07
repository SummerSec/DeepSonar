import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";

const suites = ["bookworm", "bookworm-updates", "bookworm-security"];
const archive = suite => suite === "bookworm-security" ? "debian-security" : "debian";
const snapshotUrl = (input, suite) => `https://snapshot.debian.org/archive/${archive(suite)}/${input.snapshot}/`;

export function aptSources(input) {
  if (!input || Object.keys(input).sort().join(",") !== "inReleases,snapshot" ||
      typeof input.snapshot !== "string" || !/^\d{8}T\d{6}Z$/u.test(input.snapshot) ||
      !input.inReleases || Object.keys(input.inReleases).length !== suites.length ||
      suites.some(suite => !/^[a-f0-9]{64}$/u.test(input.inReleases[suite] ?? ""))) {
    throw new Error("APT_SNAPSHOT_INPUT_INVALID");
  }
  return suites.map(suite => [
    "Types: deb", `URIs: ${snapshotUrl(input, suite)}`,
    `Suites: ${suite}`, "Components: main",
    "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
    // Historical snapshots expire by design. Exact consumed InRelease hashes
    // and APT's signature/index checks remain mandatory; no live fallback.
    "Check-Valid-Until: no", "",
  ].join("\n")).join("\n");
}

function verifyHash(input, suite, bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== input.inReleases[suite]) throw new Error(`APT_INRELEASE_IDENTITY_MISMATCH: ${suite}`);
}

export async function verifyAptMetadata(input, fetchImpl = fetch) {
  aptSources(input);
  for (const suite of suites) {
    const response = await fetchImpl(`${snapshotUrl(input, suite)}dists/${suite}/InRelease`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`APT_SNAPSHOT_UNAVAILABLE: ${suite} HTTP ${response.status}`);
    verifyHash(input, suite, Buffer.from(await response.arrayBuffer()));
  }
}

export function verifyAptLists(input, readImpl = readFileSync) {
  aptSources(input);
  for (const suite of suites) {
    const prefix = snapshotUrl(input, suite).replace("https://", "").replaceAll("/", "_");
    let bytes;
    try { bytes = readImpl(`/var/lib/apt/lists/${prefix}dists_${suite}_InRelease`); }
    catch { throw new Error(`APT_INRELEASE_UNAVAILABLE: ${suite}`); }
    verifyHash(input, suite, bytes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (process.argv[3] === "verify-lists") {
    verifyAptLists(input);
  } else if (process.argv[3] === undefined) {
    await verifyAptMetadata(input);
    // node:22-bookworm-slim has bundled Node trust roots but no system CA
    // bundle. Bootstrap HTTPS APT from that immutable parent, not live inputs.
    mkdirSync("/etc/ssl/certs", { recursive: true });
    writeFileSync("/etc/ssl/certs/ca-certificates.crt", `${rootCertificates.join("\n")}\n`);
    const directory = "/etc/apt/sources.list.d";
    for (const name of readdirSync(directory)) {
      if (/\.(?:list|sources)$/u.test(name)) rmSync(`${directory}/${name}`);
    }
    rmSync("/etc/apt/sources.list", { force: true });
    writeFileSync(`${directory}/debian.sources`, aptSources(input));
  } else {
    throw new Error("APT_SNAPSHOT_INPUT_INVALID");
  }
}
