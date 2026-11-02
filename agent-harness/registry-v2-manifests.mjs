// Registry v2 manifest inspection for hosts without Docker CLI buildx (#845).
//
// The upgrade path must verify digest, platform set and child manifests on every
// published channel before it may switch a deployment. Docker CLI provides that via
// `docker buildx imagetools inspect --raw`; podman/buildah does not. This module is
// an equal-strength alternative, not a relaxation:
//
//   - the request is pinned to an immutable digest reference;
//   - the response body is hashed and must match that digest (content addressing is
//     the verification, exactly as buildx relies on it);
//   - only OCI index / Docker manifest-list / single-manifest media types are
//     accepted, so a registry error page cannot pass as an index;
//   - platform and child-digest checks still run in runtime-platform-manifests.mjs
//     on the returned document, and cosign signature verification is unchanged.
//
// Anything unverifiable (no credentials, unexpected status, digest mismatch) fails
// closed with one actionable message. There is no "best effort" mode.
import {createHash} from "node:crypto";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const ACCEPT = [...MANIFEST_MEDIA_TYPES].join(", ");

const fail = (message, code) => Object.assign(new Error(`registry-v2-manifests: ${message}`), {code});

/** Parse `<registry>/<repository>@sha256:<digest>`. Tag references are refused. */
export function parseRegistryRef(ref) {
  if (typeof ref !== "string" || ref.includes("://") || /\s/u.test(ref)) {
    throw fail(`an immutable image reference is required, got ${JSON.stringify(String(ref).slice(0, 120))}`);
  }
  const at = ref.lastIndexOf("@");
  if (at < 1) throw fail(`reference must be pinned by sha256 digest: ${ref}`);
  const name = ref.slice(0, at);
  const digest = ref.slice(at + 1);
  if (!DIGEST_RE.test(digest)) throw fail(`reference must be pinned by sha256 digest: ${name}`);
  const slash = name.indexOf("/");
  if (slash < 1) throw fail(`reference must include a registry host: ${name}`);
  const registry = name.slice(0, slash);
  const repository = name.slice(slash + 1);
  if (!REPOSITORY_RE.test(repository)) throw fail(`invalid registry reference: ${name}`);
  return {registry, repository, digest};
}

function bearerChallenge(headerValue) {
  if (typeof headerValue !== "string" || !/^Bearer /iu.test(headerValue)) return null;
  const params = {};
  for (const match of headerValue.slice(7).matchAll(/([A-Za-z_]+)="([^"]*)"/gu)) params[match[1]] = match[2];
  return params.realm ? params : null;
}

async function pullToken(challenge, repository, fetchImpl) {
  let url;
  try {
    url = new URL(challenge.realm);
  } catch {
    return null; // Unparsable challenge realm: treat as "no anonymous pull possible".
  }
  if (challenge.service) url.searchParams.set("service", challenge.service);
  url.searchParams.set("scope", challenge.scope ?? `repository:${repository}:pull`);
  const response = await fetchImpl(url.toString(), {headers: {Accept: "application/json"}});
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (typeof body?.token === "string") return body.token;
  if (typeof body?.access_token === "string") return body.access_token;
  return null;
}

/**
 * Fetch the raw manifest document for an immutable reference and verify that the
 * bytes hash to the requested digest.
 *
 * @returns {Promise<{raw: string, digest: string, mediaType: string}>}
 */
export async function fetchRegistryManifest(ref, {fetchImpl = fetch} = {}) {
  const {registry, repository, digest} = parseRegistryRef(ref);
  const url = `https://${registry}/v2/${repository}/manifests/${digest}`;
  const request = token => fetchImpl(url, {
    headers: {Accept: ACCEPT, ...(token ? {Authorization: `Bearer ${token}`} : {})},
    redirect: "follow",
  });

  let response;
  try {
    response = await request();
  } catch (error) {
    throw fail(`${registry} is unreachable (${error?.message ?? "network error"}); inspecting without docker buildx needs outbound HTTPS to the registry`, "REGISTRY_UNREACHABLE");
  }
  if (response.status === 401) {
    const challenge = bearerChallenge(response.headers?.get?.("www-authenticate"));
    const token = challenge ? await pullToken(challenge, repository, fetchImpl) : null;
    if (!token) {
      throw fail(`${registry}/${repository} needs registry credentials for anonymous inspection; configure credentials for that registry, or inspect from a host that has docker buildx`, "REGISTRY_AUTH_REQUIRED");
    }
    response = await request(token);
  }
  if (!response.ok) {
    throw fail(`manifest ${digest} of ${registry}/${repository} returned HTTP ${response.status}`, "REGISTRY_MANIFEST_UNAVAILABLE");
  }
  const mediaType = response.headers?.get?.("content-type")?.split(";")[0]?.trim() ?? "";
  if (!MANIFEST_MEDIA_TYPES.has(mediaType)) {
    throw fail(`${registry}/${repository} returned unexpected content type ${mediaType || "(none)"}`, "REGISTRY_MEDIA_TYPE_UNEXPECTED");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== digest) {
    throw fail(`${registry}/${repository} served ${actual} for requested ${digest}`, "REGISTRY_DIGEST_MISMATCH");
  }
  return {raw: bytes.toString("utf8"), digest: actual, mediaType};
}

/** Parsed manifest document, equivalent to `docker buildx imagetools inspect --raw`. */
export async function inspectRegistryManifest(ref, options = {}) {
  const {raw} = await fetchRegistryManifest(ref, options);
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(`manifest ${ref} is not valid JSON`, "REGISTRY_MANIFEST_INVALID");
  }
}