import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import {
  ROLE_UI_COLOR_ASSIGNABLE,
  ROLE_UI_COLOR_PATTERN,
  ROLE_UI_COLOR_RESERVED,
} from "@deepsonar/shared-types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("role color API and platform import integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("role API allocation, delete release, semantic nulls, and import remapping", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.DEEPSONAR_AUTH_REQUIRED = "false";
    const { migrate, sql } = await import("./db.js");
    const { registerRoutes } = await import("./routes.js");
    const { buildPlatformManifest } = await import("./transfer/platform.js");
    const { writeDeepsonarPack, sha256Hex } = await import("./transfer/pack.js");
    const { applyPlatformImport } = await import("./transfer/platform.js");
    await migrate();

    const suffix = randomUUID().slice(0, 8);
    const rolePrefix = `issue42_${suffix}`;
    const createdNames: string[] = [];
    const app = Fastify({ logger: false });
    registerRoutes(app);
    await app.ready();
    let packPath: string | null = null;
    let importId: string | null = null;
    try {
      const payloads = Array.from({ length: 8 }, (_, index) => ({
        name: `${rolePrefix}_${index}`,
        title: `Issue 42 role ${index}`,
        description: "allocator integration",
      }));
      createdNames.push(...payloads.map((payload) => payload.name));
      const responses = await Promise.all(payloads.map((payload) => app.inject({
        method: "POST",
        url: "/agent-roles",
        payload,
      })));
      assert.ok(
        responses.every((response) => response.statusCode === 200),
        responses.map((response) => `${response.statusCode}:${response.body}`).join(" | "),
      );
      const created = responses.map((response) => response.json() as { id: string; ui_color: string });
      assert.equal(new Set(created.map((row) => row.ui_color)).size, created.length);
      assert.ok(created.every((row) => ROLE_UI_COLOR_PATTERN.test(row.ui_color)));
      assert.ok(created.every((row) => !ROLE_UI_COLOR_RESERVED.includes(row.ui_color as never)));

      const duplicate = await app.inject({ method: "POST", url: "/agent-roles", payload: payloads[0] });
      assert.equal(duplicate.statusCode, 409);

      // Occupy every assignable slot except the first created role's color so
      // the subsequent API create must prove that deletion releases it.
      const released = created[0]!;
      const occupiedRows = await sql<{ ui_color: string | null }[]>`
        SELECT ui_color FROM agent_roles WHERE kind = 'role' AND ui_color IS NOT NULL`;
      const occupied = new Set(occupiedRows.map((row) => row.ui_color?.toLowerCase()).filter(Boolean));
      for (const color of ROLE_UI_COLOR_ASSIGNABLE) {
        if (color === released.ui_color || occupied.has(color)) continue;
        const name = `${rolePrefix}_occupy_${createdNames.length}`;
        createdNames.push(name);
        await sql`
          INSERT INTO agent_roles (name, title, description, builtin, kind, ui_color)
          VALUES (${name}, ${name}, '', false, 'role', ${color})`;
      }
      const deleted = await app.inject({ method: "DELETE", url: `/agent-roles/${released.id}` });
      assert.equal(deleted.statusCode, 200);
      const replacementName = `${rolePrefix}_replacement`;
      createdNames.push(replacementName);
      const replacementResponse = await app.inject({
        method: "POST",
        url: "/agent-roles",
        payload: { name: replacementName, title: replacementName, description: "" },
      });
      assert.equal(replacementResponse.statusCode, 200);
      assert.equal((replacementResponse.json() as { ui_color: string }).ui_color, released.ui_color);

      const semanticRoles = await sql<{ kind: string; ui_color: string | null }[]>`
        SELECT kind, ui_color FROM agent_roles WHERE kind IN ('hub', 'system')`;
      assert.ok(semanticRoles.length > 0);
      assert.ok(semanticRoles.every((row) => row.ui_color === null));

      const importExisting = `${rolePrefix}_import_existing`;
      const importNew = `${rolePrefix}_import_new`;
      createdNames.push(importExisting, importNew);
      await sql`
        INSERT INTO agent_roles (name, title, description, builtin, kind, ui_color)
        VALUES (${importExisting}, ${importExisting}, '', false, 'role', ${ROLE_UI_COLOR_RESERVED[0]})`;

      const manifest = buildPlatformManifest({
        preset: "custom",
        modules: ["agent_roles"],
        counts: { agent_roles: 3 },
        credentialsMode: "metadata",
        instanceId: "issue42-test",
      });
      const files = [{
        path: "data/agent-roles.jsonl",
        content: [
          {
            name: importExisting,
            title: importExisting,
            description: "updated",
            builtin: false,
            kind: "role",
            // Collides with the built-in analyze role and must be remapped.
            ui_color: ROLE_UI_COLOR_ASSIGNABLE[0],
          },
          {
            name: importNew,
            title: importNew,
            description: "new",
            builtin: false,
            kind: "role",
            // Reserved semantic color must never be imported as a role color.
            ui_color: ROLE_UI_COLOR_RESERVED[0],
          },
          {
            name: "hub_reason",
            title: "Hub",
            description: "updated hub",
            builtin: true,
            kind: "hub",
            ui_color: ROLE_UI_COLOR_RESERVED[1],
          },
        ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      }];
      packPath = path.join(os.tmpdir(), `${rolePrefix}.deepsonarpack`);
      await writeDeepsonarPack(files, manifest, packPath);
      importId = randomUUID();
      await sql`
        INSERT INTO data_imports
          (id, source_artifact_uri, source_sha256, scope, status, selected_modules_json)
        VALUES
          (${importId}, ${packPath}, ${sha256Hex(await readFile(packPath))},
           'platform', 'uploaded', ${sql.json(["agent_roles"] as never)})`;
      const applied = await applyPlatformImport(importId, {});
      assert.equal(applied.ok, true);
      const [existingAfter] = await sql<{ ui_color: string }[]>`
        SELECT ui_color FROM agent_roles WHERE name = ${importExisting}`;
      const [newAfter] = await sql<{ ui_color: string }[]>`
        SELECT ui_color FROM agent_roles WHERE name = ${importNew}`;
      assert.ok(existingAfter && newAfter);
      assert.ok(ROLE_UI_COLOR_PATTERN.test(existingAfter.ui_color));
      assert.ok(ROLE_UI_COLOR_PATTERN.test(newAfter.ui_color));
      assert.equal(ROLE_UI_COLOR_RESERVED.includes(existingAfter.ui_color as never), false);
      assert.equal(ROLE_UI_COLOR_RESERVED.includes(newAfter.ui_color as never), false);
      assert.notEqual(existingAfter.ui_color, ROLE_UI_COLOR_ASSIGNABLE[0]);
      assert.notEqual(newAfter.ui_color, ROLE_UI_COLOR_RESERVED[0]);
      const [hubAfter] = await sql<{ ui_color: string | null }[]>`
        SELECT ui_color FROM agent_roles WHERE name = 'hub_reason'`;
      assert.equal(hubAfter?.ui_color, null);
    } finally {
      if (importId) await sql`DELETE FROM data_imports WHERE id = ${importId}`;
      await sql`DELETE FROM agent_roles WHERE name = ANY(${createdNames.concat([`${rolePrefix}_import_existing`, `${rolePrefix}_import_new`])})`;
      await app.close();
      await sql.end({ timeout: 5 });
      if (packPath) await rm(packPath, { force: true });
    }
  });
}
