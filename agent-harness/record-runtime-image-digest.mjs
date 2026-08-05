import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  inspectPublishedImageDigest,
  inspectPublishedImageSize,
} from "./oci-image-size.mjs";
import { buildRegistryRecord } from "./runtime-image-record.mjs";

const output = process.argv[2];
if (!output) throw new Error("Usage: node record-runtime-image-digest.mjs <output-file>");

const required = ["IMAGE_KEY", "DIGEST", "PLATFORMS", "GHCR_REF", "VERSION"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
}
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CHANNELS = ["github", "dockerhub", "aliyun-acr"];
if (!DIGEST_RE.test(process.env.DIGEST)) {
  throw new Error(`build-push-action digest is invalid: ${process.env.DIGEST}`);
}

const platforms = process.env.PLATFORMS.split(",").map((platform) => platform.trim()).filter(Boolean);
if (platforms.length === 0) throw new Error("At least one target platform is required");
if (new Set(platforms).size !== platforms.length) throw new Error("Target platforms must be unique");

const canonicalDigest = process.env.DIGEST;
if (process.env.CHANNEL_PUBLISH_FAILED === "true") {
  throw new Error("registry channel publication failed; refusing to create an unchecked release record");
}

function configured(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] === "true";
}

function firstTag(name) {
  return process.env[name]?.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "";
}

async function inspectChannel(channel, reference, isAvailable, unavailableReason) {
  if (!isAvailable) {
    return buildRegistryRecord({
      channel,
      configured: false,
      reference,
      canonicalDigest,
      unavailableReason,
    });
  }
  let inspectedDigest;
  try {
    inspectedDigest = await inspectPublishedImageDigest(reference);
  } catch (inspectError) {
    return buildRegistryRecord({
      channel,
      configured: true,
      reference,
      canonicalDigest,
      inspectError,
      unavailableReason,
    });
  }
  return buildRegistryRecord({
    channel,
    configured: true,
    reference,
    canonicalDigest,
    inspectedDigest,
    unavailableReason,
  });
}

const githubReference = process.env.GHCR_REF.includes("@")
  ? process.env.GHCR_REF
  : `${process.env.GHCR_REF}@${canonicalDigest}`;
const records = {
  github: await inspectChannel("github", githubReference, true),
  dockerhub: await inspectChannel(
    "dockerhub",
    process.env.DOCKERHUB_REF || firstTag("DOCKERHUB_TAGS"),
    configured("DOCKERHUB_CONFIGURED", Boolean(process.env.DOCKERHUB_REF || firstTag("DOCKERHUB_TAGS"))),
    process.env.DOCKERHUB_UNAVAILABLE_REASON || "credentials_missing",
  ),
  "aliyun-acr": await inspectChannel(
    "aliyun-acr",
    process.env.ACR_REF || firstTag("ACR_TAGS"),
    configured("ACR_CONFIGURED", Boolean(process.env.ACR_REF || firstTag("ACR_TAGS"))),
    process.env.ACR_UNAVAILABLE_REASON || "credentials_missing",
  ),
};

const ghcrRef = records.github.ref;
const size = await inspectPublishedImageSize(ghcrRef, platforms);
const registryRefs = Object.fromEntries(
  CHANNELS
    .filter((channel) => records[channel].available)
    .map((channel) => [channel, records[channel].ref]),
);

const descriptor = {
  image_key: process.env.IMAGE_KEY,
  version: process.env.VERSION,
  digest: canonicalDigest,
  platforms,
  size_bytes: size.size_bytes,
  platform_size_bytes: size.platform_size_bytes,
  platform_digests: size.platform_digests ?? {},
  // `registry_records` is the release evidence contract. It deliberately
  // includes unavailable optional channels so missing credentials are visible
  // instead of becoming fabricated host@canonical-digest references.
  registry_records: records,
  // This convenience map is restricted to channels that passed the actual
  // inspect gate; the generator re-validates every record.
  registry_refs: registryRefs,
  // Preserve the legacy projection for the current Scheduler consumer.
  ghcr_ref: ghcrRef,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(descriptor, null, 2)}\n`);
