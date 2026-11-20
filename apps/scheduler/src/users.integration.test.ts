import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("default user integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("seeds from a deployment file once, fails closed without it, and never resets existing accounts", async () => {
    // Install the explicit URL before importing scheduler modules so a local
    // .env can never redirect this test to a real development database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const {
      BOOTSTRAP_ADMIN_USERNAME,
      createUser,
      ensureBootstrapAdmin,
      loginUser,
      setUserPassword,
      setUserUsername,
    } = await import("./users.js");
    await migrate();
    const dir = await mkdtemp(join(tmpdir(), "deepsonar-admin-test-"));
    const secretPath = join(dir, "password");
    const seedPassword = `${randomUUID()}A!`;

    try {
      const [before] = await sql`SELECT COUNT(*)::int AS n FROM users`;
      assert.equal(Number(before.n), 0, "auth integration requires a fresh users table");

      await assert.rejects(ensureBootstrapAdmin(""), /BOOTSTRAP_ADMIN_PASSWORD_FILE_REQUIRED/);
      await assert.rejects(ensureBootstrapAdmin(secretPath), /BOOTSTRAP_ADMIN_PASSWORD_FILE_INVALID/);
      await assert.rejects(ensureBootstrapAdmin(dir), /BOOTSTRAP_ADMIN_PASSWORD_FILE_INVALID/);
      await writeFile(secretPath, "short", {mode: 0o600});
      await assert.rejects(ensureBootstrapAdmin(secretPath), /BOOTSTRAP_ADMIN_PASSWORD_INVALID/);
      assert.equal(Number((await sql`SELECT COUNT(*)::int AS n FROM users`)[0].n), 0);
      const api = Fastify();
      const { registerAuthRoutes } = await import("./domains/auth/routes.js");
      registerAuthRoutes(api);
      try {
        const response = await api.inject({method: "POST", url: "/auth/bootstrap",
          payload: {username: "bootstrap.fixture", password: randomUUID()}});
        assert.equal(response.statusCode, 403);
        assert.equal(response.json().error_code, "BOOTSTRAP_REQUIRES_DEPLOYMENT_SECRET");
        assert.equal(Number((await sql`SELECT COUNT(*)::int AS n FROM users`)[0].n), 0);
      } finally {
        await api.close();
      }
      await writeFile(secretPath, `${seedPassword}\r\n`);
      const [first, second] = await Promise.all([ensureBootstrapAdmin(secretPath), ensureBootstrapAdmin(secretPath)]);
      assert.equal([first, second].filter((result) => result.created).length, 1);
      assert.ok(first.user || second.user);

      const [row] = await sql`
        SELECT id, username, password_hash, password_salt, role, status
        FROM users WHERE username = ${BOOTSTRAP_ADMIN_USERNAME}`;
      assert.ok(row);
      assert.equal(row.role, "admin");
      assert.equal(row.status, "active");

      const originalHash = row.password_hash as string;
      const [auditRow] = await sql`
        SELECT COUNT(*)::int AS n,
               COALESCE(string_agg(after_json::text, ' '), '') AS metadata
        FROM audit_logs WHERE action = 'auth.bootstrap_admin_seed'`;
      assert.equal(Number(auditRow.n), 1);
      assert.doesNotMatch(auditRow.metadata as string, /password|salt|hash/i);
      assert.ok(!String(auditRow.metadata).includes(seedPassword));

      const firstLogin = await loginUser(BOOTSTRAP_ADMIN_USERNAME, seedPassword);
      assert.equal(firstLogin.user.username, BOOTSTRAP_ADMIN_USERNAME);

      const changedPassword = `${randomUUID()}A!`;
      await setUserPassword(row.id as string, changedPassword);
      const afterPasswordChange = await ensureBootstrapAdmin(join(dir, "nonexistent"));
      assert.equal((await ensureBootstrapAdmin("")).created, false);
      await writeFile(secretPath, `${randomUUID()}A!`);
      assert.equal((await ensureBootstrapAdmin(secretPath)).created, false);
      assert.equal(afterPasswordChange.created, false);

      const [afterEnsure] = await sql`SELECT password_hash FROM users WHERE id = ${row.id as string}`;
      assert.notEqual(afterEnsure.password_hash, originalHash);
      await assert.rejects(() => loginUser(BOOTSTRAP_ADMIN_USERNAME, seedPassword));
      await loginUser(BOOTSTRAP_ADMIN_USERNAME, changedPassword);

      const renamed = "admin.integration";
      const renamedUser = await setUserUsername(row.id as string, renamed);
      assert.equal(renamedUser?.username, renamed);

      await assert.rejects(() => loginUser(BOOTSTRAP_ADMIN_USERNAME, changedPassword));
      await loginUser(renamed, changedPassword);

      const collision = await createUser({
        username: `collision-${randomUUID().slice(0, 8)}`,
        password: `${randomUUID()}A!`,
      });
      await assert.rejects(
        () => setUserUsername(row.id as string, collision.username),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "USERNAME_TAKEN"),
      );
      await sql`DELETE FROM users WHERE id = ${collision.id}`;


    } finally {
      await rm(dir, {recursive:true, force:true});
      await sql`DELETE FROM user_sessions`;
      await sql.end({ timeout: 5 });
    }
  });
}
