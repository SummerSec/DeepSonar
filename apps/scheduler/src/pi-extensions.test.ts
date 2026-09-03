import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PI_EXTENSION_REGISTRY,
  PI_EXTENSION_SANDBOX_PREFIX,
  validatePiExtensionIds,
} from "@deepsonar/shared-types";
import {
  freezePiExtensions,
  materializeFrozenPiExtensions,
  parseFrozenPiExtensions,
  piExtensionLoaderSource,
} from "./pi-extensions.js";

test("RoleConfig 只接受已注册的 Pi 扩展", () => {
  assert.equal(validatePiExtensionIds([], "pi"), null);
  assert.equal(validatePiExtensionIds(["pi-web-access"], "pi"), null);
  assert.match(validatePiExtensionIds(["not-a-real-ext"], "pi") ?? "", /未注册/);
  assert.match(validatePiExtensionIds(["pi-web-access"], "claude-code") ?? "", /仅 agent_cli=pi/);
  assert.match(validatePiExtensionIds(["PI_WEB"], "pi") ?? "", /非法/);
});

test("Job 创建冻结已注册扩展，未注册与不兼容镜像失败", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]?.id, "pi-web-access");
  assert.equal(frozen[0]?.version, PI_EXTENSION_REGISTRY["pi-web-access"].version);
  assert.equal(frozen[0]?.integrity, PI_EXTENSION_REGISTRY["pi-web-access"].integrity);
  assert.equal(frozen[0]?.workspace_path, ".pi/agent/extensions/pi-web-access.ts");
  assert.ok(frozen[0]?.entry_path.startsWith("/opt/deepsonar/pi-extensions/node_modules/"));
  assert.deepEqual(freezePiExtensions([], "claude-code", "deepsonar-base"), []);
  assert.throws(() => freezePiExtensions(["ghost-ext"], "pi", "deepsonar-audit"), /未注册/);
  assert.throws(() => freezePiExtensions(["pi-web-access"], "pi", "deepsonar-base"), /不兼容/);
  assert.throws(() => freezePiExtensions(["pi-web-access"], "pi", "deepsonar-chrome-audit"), /不兼容/);
});

test("冻结快照重放拒绝被改写的入口与未注册 id", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  assert.deepEqual(parseFrozenPiExtensions(frozen), frozen);
  assert.deepEqual(parseFrozenPiExtensions(undefined), []);
  assert.throws(() => parseFrozenPiExtensions([{ ...frozen[0], id: "ghost-ext" }]), /未注册/);
  assert.throws(() => parseFrozenPiExtensions([{ ...frozen[0], entry_path: "/tmp/evil.ts" }]), /入口路径非法/);
  assert.throws(
    () => parseFrozenPiExtensions([{ ...frozen[0], version: "0.0.1" }]),
    /与当前注册表不一致/,
  );
});

test("物化只生成注册路径 stub，禁网时跳过出网扩展", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  const allowed = materializeFrozenPiExtensions(frozen, true);
  assert.equal(allowed.paths.length, 1);
  assert.ok(allowed.paths[0]?.startsWith(PI_EXTENSION_SANDBOX_PREFIX));
  assert.equal(allowed.files[0]?.path, ".pi/agent/extensions/pi-web-access.ts");
  assert.match(allowed.files[0]?.content ?? "", /export \{ default \} from "\/opt\/deepsonar\/pi-extensions\/node_modules\/pi-web-access\/index\.ts"/);
  assert.equal(allowed.skipped.length, 0);
  const denied = materializeFrozenPiExtensions(frozen, false);
  assert.deepEqual(denied.paths, []);
  assert.deepEqual(denied.files, []);
  assert.deepEqual(denied.skipped, [{ id: "pi-web-access", reason: "requires_egress" }]);
});

test("扩展入口与 RoleConfig 上传路径均拒绝穿越", () => {
  assert.throws(() => piExtensionLoaderSource("/tmp/evil.ts"), /PI_EXTENSION_ENTRY_PATH_INVALID/);
  assert.throws(
    () => piExtensionLoaderSource("/opt/deepsonar/pi-extensions/node_modules/../escape.ts"),
    /PI_EXTENSION_ENTRY_PATH_INVALID/,
  );
  const core = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
  assert.match(core, /Pi 扩展只能通过 RoleConfig\.pi_extensions 声明已注册扩展，不能上传扩展源码/);
  assert.match(core, /\.pi\\\/agent\\\/extensions/);
  const executor = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(executor, /materializeFrozenPiExtensions/);
  assert.match(executor, /piExtensions: piExtensionInjection\.paths/);
  assert.doesNotMatch(executor, /filter\(\(file\) => file\.path\.startsWith\("\.pi\/agent\/extensions\/"\)\)/);
});
