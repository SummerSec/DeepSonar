import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "agent-harness", "validate-changelog.mjs");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "deepsonar-changelog-"));
const file = path.join(tempRoot, "CHANGELOG.md");
const output = path.join(tempRoot, "section.md");
const base = `# Changelog\n\n## [Unreleased]\n\n## [0.1.19] - 2026-08-07\n\n### Fixed\n\n- A verified fix.\n\n## [0.1.18] - 2026-08-07\n\n### Fixed\n\n- An older verified fix.\n\n[0.1.19]: https://github.com/SummerSec/DeepSonar/compare/v0.1.18...v0.1.19\n[0.1.18]: https://github.com/SummerSec/DeepSonar/compare/v0.1.17...v0.1.18\n`;
const current = `# Changelog\n\n## [Unreleased]\n\n## [0.1.20] - 2026-08-08\n\n### Added\n\n- A new release.\n\n## [0.1.19] - 2026-08-07\n\n### Fixed\n\n- A verified fix.\n\n## [0.1.18] - 2026-08-07\n\n### Fixed\n\n- An older verified fix.\n\n[0.1.20]: https://github.com/SummerSec/DeepSonar/compare/v0.1.19...v0.1.20\n[0.1.19]: https://github.com/SummerSec/DeepSonar/compare/v0.1.18...v0.1.19\n[0.1.18]: https://github.com/SummerSec/DeepSonar/compare/v0.1.17...v0.1.18\n`;

function run(args, expectedError) {
  if (expectedError) {
    assert.throws(() => execFileSync(process.execPath, [validator, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }), expectedError);
    return;
  }
  return execFileSync(process.execPath, [validator, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  writeFileSync(file, current, "utf8");
  run(["--file", file, "--version", "0.1.20", "--previous-version", "0.1.19", "--tag", "v0.1.20", "--output", output]);
  assert.match(readFileSync(output, "utf8"), /^## \[0\.1\.20\]/u);

  run(["--file", path.join(tempRoot, "missing.md"), "--version", "0.1.20"], /ENOENT/u);
  writeFileSync(file, base, "utf8");
  run(["--file", file, "--version", "0.1.20", "--previous-version", "0.1.19"], /exactly one section/u);
  writeFileSync(file, base.replace("### Fixed\n\n- A verified fix.", "### Fixed\n"), "utf8");
  run(["--file", file, "--version", "0.1.19", "--previous-version", "0.1.18"], /must not be empty/u);
  writeFileSync(file, `${base}\n## [0.1.19] - 2026-08-08\n\n- Duplicate.\n`, "utf8");
  run(["--file", file, "--version", "0.1.19", "--previous-version", "0.1.18"], /duplicate version section/u);
  writeFileSync(file, base.replace("v0.1.18...v0.1.19", "v0.1.17...v0.1.19"), "utf8");
  run(["--file", file, "--version", "0.1.19", "--previous-version", "0.1.18"], /compare link/u);
  writeFileSync(file, base, "utf8");
  run(["--file", file, "--version", "0.1.19", "--previous-version", "0.1.18", "--tag", "v0.1.20"], /does not match/u);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("changelog validation valid, missing, duplicate, empty, compare-link, and tag-mismatch cases passed");
