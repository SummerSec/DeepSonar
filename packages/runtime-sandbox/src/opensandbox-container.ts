/**
 * In-container markers for the pinned OpenSandbox server (#422).
 * Official server only checks `/.dockerenv`; Podman writes `/run/.containerenv`.
 */
export const DOCKER_CONTAINER_MARKER = "/.dockerenv";
export const PODMAN_CONTAINER_MARKER = "/run/.containerenv";

export function runningInsideDockerContainer(
  exists: (path: string) => boolean,
): boolean {
  return exists(DOCKER_CONTAINER_MARKER) || exists(PODMAN_CONTAINER_MARKER);
}
