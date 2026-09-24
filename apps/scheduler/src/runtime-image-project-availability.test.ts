import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_BASE_RUNTIME_IMAGE_KEY,
  isProjectRuntimeImageAvailable,
} from "./runtime-images.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

test("#691 deepsonar-base is never project-disableable", () => {
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: PLATFORM_BASE_RUNTIME_IMAGE_KEY,
    official: true,
    projectEnabled: false,
    projectId,
  }), true);
});

test("#691 official non-base can be excluded", () => {
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: "deepsonar-audit",
    official: true,
    projectEnabled: null,
    projectId,
  }), true);
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: "deepsonar-audit",
    official: true,
    projectEnabled: false,
    projectId,
  }), false);
});

test("#691 third-party requires visible binding and enable", () => {
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: "acme-tools",
    official: false,
    projectEnabled: true,
    visibleProjectIds: [],
    projectId,
  }), false);
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: "acme-tools",
    official: false,
    projectEnabled: true,
    visibleProjectIds: [other],
    projectId,
  }), false);
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: "acme-tools",
    official: false,
    projectEnabled: null,
    visibleProjectIds: [projectId],
    projectId,
  }), false);
  assert.equal(isProjectRuntimeImageAvailable({
    imageKey: "acme-tools",
    official: false,
    projectEnabled: true,
    visibleProjectIds: [projectId],
    projectId,
  }), true);
});
