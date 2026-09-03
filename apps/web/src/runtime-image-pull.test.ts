import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatPullElapsed,
  isRegistryChannelSwitchLocked,
  isRuntimeImagePullBusyError,
  preferredPullItem,
  projectBindingQueuedNotice,
  projectBindingDeferredNotice,
  pullHeadline,
  pullItemStatusLabel,
  pullPurposeLabel,
  registryChannelBusyNotice,
  registryChannelDeferredNotice,
  registryChannelSelectValue,
  shouldKeepPollingPullStatus,
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
    "已加入拉取队列：DeepSonar Chrome Audit；绑定尚未保存，该项就绪后会自动启用",
  );
});

test("preferred pull item skips a failed digest so retry can bind", () => {
  const failed = { image_key: "kali", status: "failed" as const };
  const queued = { image_key: "kali", status: "queued" as const };
  assert.equal(preferredPullItem([failed], "kali")?.status, "failed");
  assert.equal(preferredPullItem([failed, queued], "kali")?.status, "queued");
  assert.equal(shouldKeepPollingPullStatus("succeeded", 1), true);
  assert.equal(shouldKeepPollingPullStatus("succeeded", 0), false);
  assert.equal(shouldKeepPollingPullStatus("running", 0), true);
});

test("busy errors are treated as queue progress, not a hard wait", () => {
  assert.equal(isRuntimeImagePullBusyError("PUT /projects/x/runtime-images/y -> 409: runtime_image_preparation_busy: already running"), true);
  assert.equal(projectBindingQueuedNotice("DeepSonar Kali", {
    task_id: "task",
    purpose: "project_binding:p:i",
    status: "running",
    started_at: "2026-08-18T16:00:00.000Z",
    finished_at: null,
    total: 2,
    completed: 0,
    items: [],
  }), "已加入拉取队列：DeepSonar Kali（0/2）");
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
  assert.match(page, /projectBindingQueuedNotice/);
  assert.match(page, /pendingProjectBinds/);
  assert.match(page, /preferredPullItem/);
  assert.match(page, /shouldKeepPollingPullStatus/);
  assert.doesNotMatch(page, /请等待完成后再启用/);
  assert.doesNotMatch(page, /if \(projectId\) return;\s*void api\.runtimeImagesPullStatus/);
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
