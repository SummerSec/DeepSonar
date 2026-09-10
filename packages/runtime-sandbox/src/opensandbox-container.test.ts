import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCKER_CONTAINER_MARKER,
  PODMAN_CONTAINER_MARKER,
  runningInsideDockerContainer,
} from "./opensandbox-container.js";

function existsIn(...paths: string[]): (path: string) => boolean {
  const present = new Set(paths);
  return (path) => present.has(path);
}

test("Docker /.dockerenv is treated as in-container", () => {
  assert.equal(runningInsideDockerContainer(existsIn(DOCKER_CONTAINER_MARKER)), true);
});

test("Podman /run/.containerenv without /.dockerenv is treated as in-container", () => {
  assert.equal(runningInsideDockerContainer(existsIn(PODMAN_CONTAINER_MARKER)), true);
});

test("neither container marker means not in-container", () => {
  assert.equal(runningInsideDockerContainer(existsIn()), false);
});
