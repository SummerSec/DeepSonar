import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** #641: typing "/" mid-path for /v1 must not be stripped by controlled onChange. */
describe("provider Base URL draft input (#641)", () => {
  it("CredentialConfigEditor keeps raw onChange value", () => {
    const src = readFileSync(path.join(root, "CredentialConfigEditor.tsx"), "utf8");
    assert.ok(src.includes("onBaseUrlChange(e.target.value)"));
    assert.ok(!src.includes('onBaseUrlChange(e.target.value.trim().replace(/\\/+$/u, ""))'));
  });

  it("CcSwitch connection handlers do not strip trailing slash while typing", () => {
    for (const file of ["CcSwitchClaudeFields.tsx", "CcSwitchCodexFields.tsx", "CcSwitchOpenCodeFields.tsx"] as const) {
      const src = readFileSync(path.join(root, file), "utf8");
      assert.ok(
        !src.includes("onBaseUrlChange(sanitized)") && !src.includes("onBaseUrlChange(normalized)"),
        `${file} still forwards a slash-stripped draft`,
      );
    }
  });

  it("ProviderAccountFlow still normalizes Base URL on save", () => {
    const src = readFileSync(path.join(root, "ProviderAccountFlow.tsx"), "utf8");
    const needle = '.replace(/\\/+$/u, "")';
    let count = 0;
    let from = 0;
    while (true) {
      const at = src.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
    }
    assert.ok(count >= 2, `expected create/edit save paths to strip trailing slashes, found ${count}`);
  });
});
