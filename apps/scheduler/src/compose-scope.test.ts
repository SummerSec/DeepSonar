import assert from "node:assert/strict";
import test from "node:test";
import { ControlInputError } from "./control-input.js";
import {
  assertComposeFindingInScope,
  assertComposeScopedHubIntent,
  composeAssetKeys,
  composeFindingMatchesSeedAssets,
  composeScopeForPrompt,
} from "./compose-scope.js";

test("compose asset keys distinguish repos and keep path modules coarse but local", () => {
  assert.deepEqual(
    composeAssetKeys("https://gitee.com/openharmony/hiview/blob/master/base/foo.cpp"),
    ["gitee.com/openharmony/hiview"],
  );
  assert.deepEqual(composeAssetKeys("gitee.com/openharmony/appexecfwk:services/a.cpp"), ["gitee.com/openharmony/appexecfwk"]);
  assert.deepEqual(composeAssetKeys("hiview/base/foo.cpp:12"), ["hiview", "hiview/base"]);
  assert.deepEqual(composeAssetKeys("src/auth.ts:10"), ["src", "src/auth.ts"]);
});

test("compose findings stay in the union of seed repos or modules", () => {
  const seeds = [{ location: "hiview/base/auth.cpp:10" }, { location: "src/cache.ts:4" }];
  assert.equal(composeFindingMatchesSeedAssets("hiview/services/session.cpp:8", seeds), true);
  assert.equal(composeFindingMatchesSeedAssets("src/token.ts:2", seeds), true);
  assert.equal(composeFindingMatchesSeedAssets("appexecfwk/src/bar.cpp:1", seeds), false);
  assert.equal(composeFindingMatchesSeedAssets(null, seeds), false);
  assert.equal(
    composeFindingMatchesSeedAssets(
      "https://gitee.com/openharmony/other/blob/master/a.cpp",
      [{ location: "https://gitee.com/openharmony/hiview/blob/master/base/a.cpp" }],
    ),
    false,
  );
});

test("compose Hub explore/audit must bind an imported seed projection", () => {
  const seeds = new Set(["11111111-1111-4111-8111-111111111111"]);
  assert.doesNotThrow(() => assertComposeScopedHubIntent("analyze", ["root"], seeds, "intents.0.from"));
  assert.doesNotThrow(() => assertComposeScopedHubIntent("explore", [...seeds], seeds, "intents.0.from"));
  assert.throws(
    () => assertComposeScopedHubIntent("explore", ["root"], seeds, "intents.0.from"),
    (error: unknown) => error instanceof ControlInputError && error.code === "invalid_payload" && error.path === "intents.0.from",
  );
  assert.throws(
    () => assertComposeScopedHubIntent("audit", [], seeds, "intents.1.from"),
    (error: unknown) => error instanceof ControlInputError && /imported 种子/.test(String(error)),
  );
});

test("compose emit_finding rejects locations outside frozen seed assets", () => {
  const seeds = [{ location: "hiview/base/foo.cpp:1" }];
  assert.doesNotThrow(() => assertComposeFindingInScope("hiview/base/bar.cpp:2", seeds));
  assert.throws(
    () => assertComposeFindingInScope("appexecfwk/src/x.cpp:1", seeds),
    (error: unknown) => error instanceof ControlInputError && error.path === "location",
  );
});

test("compose prompt scope never carries project Finding identities", () => {
  const scope = composeScopeForPrompt([
    { location: "hiview/base/foo.cpp:1" },
    { location: "hiview/base/foo.cpp:1" },
    { location: "src/a.ts:2" },
  ]);
  assert.equal(scope.mode, "seed_assets_only");
  assert.equal(scope.seed_count, 3);
  assert.deepEqual(scope.locations, ["hiview/base/foo.cpp:1", "src/a.ts:2"]);
  assert.equal("id" in scope, false);
});
