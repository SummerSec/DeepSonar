import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  OPENSANDBOX_EGRESS_IMAGE,
  OPENSANDBOX_EXECD_IMAGE,
  OPENSANDBOX_SERVER_IMAGE,
} from "./opensandbox-version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("OpenSandbox deploy pins official schema and immutable digests", () => {
  const toml = readFileSync(join(root, "deploy/opensandbox/config.toml"), "utf8");
  const compose = readFileSync(join(root, "deploy/docker-compose.opensandbox.yml"), "utf8");
  assert.match(toml, /network_mode = "bridge"/);
  assert.match(toml, /no_new_privileges = true/);
  assert.match(toml, /drop_capabilities = \["ALL"\]/);
  assert.match(toml, /type = "sqlite"/);
  assert.match(toml, /mode = "direct"/);
  assert.doesNotMatch(toml, /(?:^|\s)latest(?:\s|$)|network_mode = "host"|api_key_env|^\s*driver\s*=/m);
  assert.match(toml, new RegExp(OPENSANDBOX_EXECD_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(toml, new RegExp(OPENSANDBOX_EGRESS_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, new RegExp(OPENSANDBOX_SERVER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, /OPENSANDBOX_SERVER_API_KEY/);
  assert.match(compose, /driver: bridge/);
  assert.doesNotMatch(compose, /:latest|network_mode:\s*host/);
});
