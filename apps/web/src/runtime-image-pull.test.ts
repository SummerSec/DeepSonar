import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatPullElapsed,
  isRegistryChannelSwitchLocked,
  isRuntimeImagePullBusyError,
  projectBindingBusyNotice,
  projectBindingDeferredNotice,
  pullHeadline,
  pullItemStatusLabel,
  pullPurposeLabel,
  registryChannelBusyNotice,
  registryChannelDeferredNotice,
  registryChannelSelectValue,
  shortImageRef,
} from "./runtime-image-pull";

test("pull purpose and item labels stay readable for project enablement", () => {
  assert.equal(pullPurposeLabel("project_binding:abc:img"), "项目启用");
  assert.equal(pullPurposeLabel("admin_bulk"), "注册表预热");
  assert.equal(pullPurposeLabel("registry_channel:github"), "仓库通道切换");
  assert.equal(pullItemStatusLabel("running"), "拉取中");
  assert.equal(shortImageRef("ghcr.io/summersec/deepsonar-openharmony-audit@sha256:0123456789abcdef"), "sha256:0123456789ab");
  assert.equal(
    projectBindingDeferredNotice("DeepSonar Chrome Audit"),
    "正在后台准备 DeepSonar Chrome Audit；绑定尚未保存，拉完后再启用",
  );
});

test("busy errors point at the in-flight pull task instead of a blank 409", () => {
  assert.equal(isRuntimeImagePullBusyError("PUT /projects/x/runtime-images/y -> 409: runtime_image_preparation_busy: already running"), true);
  assert.equal(projectBindingBusyNotice({
    task_id: "task",
    purpose: "project_binding:p:i",
    status: "running",
    started_at: "2026-08-18T16:00:00.000Z",
    finished_at: null,
    total: 1,
    completed: 0,
    items: [],
  }), "当前拉取任务未完成（项目启用 0/1），请等待完成后再启用");
  assert.equal(pullHeadline({
    task_id: "task",
    status: "running",
    started_at: null,
    finished_at: null,
    total: 2,
    completed: 1,
    items: [],
  }), "拉取进度 1/2");
  assert.equal(formatPullElapsed("2026-08-18T16:00:00.000Z", "2026-08-18T16:01:05.000Z"), "1m 5s");
});

test("project runtime image page polls the shared pull-status panel", () => {
  const page = readFileSync(new URL("./pages/RuntimeImagesPage.tsx", import.meta.url), "utf8");
  assert.match(page, /api\.runtimeImagesPullStatus\(\)/);
  assert.match(page, /pullHeadline\(pullStatus\)/);
  assert.match(page, /isRuntimeImagePullBusyError/);
  assert.doesNotMatch(page, /if \(projectId\) return;\s*void api\.runtimeImagesPullStatus/);
  assert.doesNotMatch(page, /!projectId && pullStatus/);
});

test("channel switch busy is progress, not a hard failure", () => {
  assert.equal(
    registryChannelDeferredNotice("GitHub Container Registry", 3),
    "正在后台准备 GitHub Container Registry 的 3 个镜像；当前通道未切换，完成后会自动保存",
  );
  assert.equal(registryChannelBusyNotice({
    task_id: "task",
    purpose: "admin_bulk",
    status: "running",
    started_at: null,
    finished_at: null,
    total: 2,
    completed: 1,
    items: [],
  }), "当前拉取任务未完成（注册表预热 1/2），完成后会自动切换通道");
  assert.equal(registryChannelSelectValue("github", "aliyun-acr"), "github");
  assert.equal(registryChannelSelectValue(null, "aliyun-acr"), "aliyun-acr");
  assert.equal(isRegistryChannelSwitchLocked("github", { status: "running" }, null), true);
  assert.equal(isRegistryChannelSwitchLocked("github", { status: "failed" }, null), false);
  assert.equal(isRuntimeImagePullBusyError("PATCH /runtime-images/registry/channel -> 409: runtime_image_preparation_busy"), true);

  const page = readFileSync(new URL("./pages/RuntimeImagesPage.tsx", import.meta.url), "utf8");
  assert.match(page, /registryChannelSelectValue\(pendingChannel/);
  assert.match(page, /isRegistryChannelSwitchLocked\(pendingChannel/);
  assert.match(page, /registryChannelBusyNotice/);
  assert.match(page, /persistRegistryChannel\(channel\)/);
  assert.match(page, /isRuntimeImagePullBusyError\(message\)/);
  assert.match(page, /rememberInFlightChannel/);
});
