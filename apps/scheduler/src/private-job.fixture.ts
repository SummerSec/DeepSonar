/** Synthetic credentials for Actions-only unit/native fixtures. Never production authentication. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function privateJobFixture(values: { gateway?: string; control?: string; om?: string } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "deepsonar-test-auth-"));
  const directory = join(parent, `.deepsonar-credentials-${randomUUID()}`);
  // mkdirSync is separate so the leaf follows the production directory grammar.
  const files = { "gateway-token": values.gateway ?? "synthetic-main-token",
    "control-token": values.control ?? "synthetic-control-token", "om-token": values.om ?? "synthetic-om-token" };
  mkdirSync(directory, { mode: 0o700 });
  for (const [filename, value] of Object.entries(files)) writeFileSync(join(directory, filename), value, { mode: 0o600 });
  return { directory, environment: {
    DEEPSONAR_GATEWAY_TOKEN_FILE: join(directory, "gateway-token"),
    DEEPSONAR_CONTROL_TOKEN_FILE: join(directory, "control-token"),
    DEEPSONAR_OM_GATEWAY_TOKEN_FILE: join(directory, "om-token"),
  }, close: () => rmSync(parent, { recursive: true, force: true }) };
}
