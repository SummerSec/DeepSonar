import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("default user integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("seeds the default admin once, survives ensure-on-boot, and keeps scrypt/session boundaries", async () => {
    // Install the explicit URL before importing scheduler modules so a local
    // .env can never redirect this test to a real development database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const {
      DEFAULT_ADMIN_PASSWORD,
      DEFAULT_ADMIN_USERNAME,
      createUser,
      defaultAdminCredentialsActive,
      ensureDefaultAdmin,
      loginUser,
      setUserPassword,
      setUserUsername,
    } = await import("./users.js");
    await migrate();

    try {
      const [before] = await sql`SELECT COUNT(*)::int AS n FROM users`;
      assert.equal(Number(before.n), 0, "auth integration requires a fresh users table");

      const [first, second] = await Promise.all([ensureDefaultAdmin(), ensureDefaultAdmin()]);
      assert.equal([first, second].filter((result) => result.created).length, 1);
      assert.ok(first.user || second.user);

      const [row] = await sql`
        SELECT id, username, password_hash, password_salt, role, status
        FROM users WHERE username = ${DEFAULT_ADMIN_USERNAME}`;
      assert.ok(row);
      assert.equal(row.role, "admin");
      assert.equal(row.status, "active");
      assert.equal(await defaultAdminCredentialsActive(), true);
      const originalHash = row.password_hash as string;
      const [auditRow] = await sql`
        SELECT COUNT(*)::int AS n,
               COALESCE(string_agg(after_json::text, ' '), '') AS metadata
        FROM audit_logs WHERE action = 'auth.default_admin_seed'`;
      assert.equal(Number(auditRow.n), 1);
      assert.doesNotMatch(auditRow.metadata as string, /Deep@Sonar66|password|salt|hash/i);

      const firstLogin = await loginUser(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD);
      assert.equal(firstLogin.user.username, DEFAULT_ADMIN_USERNAME);

      const changedPassword = `${randomUUID()}A!`;
      await setUserPassword(row.id as string, changedPassword);
      const afterPasswordChange = await ensureDefaultAdmin();
      assert.equal(afterPasswordChange.created, false);
      assert.equal(await defaultAdminCredentialsActive(), false);
      const [afterEnsure] = await sql`SELECT password_hash FROM users WHERE id = ${row.id as string}`;
      assert.notEqual(afterEnsure.password_hash, originalHash);
      await assert.rejects(() => loginUser(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD));
      await loginUser(DEFAULT_ADMIN_USERNAME, changedPassword);

      const renamed = "admin.integration";
      const renamedUser = await setUserUsername(row.id as string, renamed);
      assert.equal(renamedUser?.username, renamed);
      assert.equal(await defaultAdminCredentialsActive(), false);
      await assert.rejects(() => loginUser(DEFAULT_ADMIN_USERNAME, changedPassword));
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

      // Restore the deterministic fixture for the auth API smoke that follows.
      await setUserUsername(row.id as string, DEFAULT_ADMIN_USERNAME);
      await setUserPassword(row.id as string, DEFAULT_ADMIN_PASSWORD);
      assert.equal(await defaultAdminCredentialsActive(), true);
    } finally {
      await sql`DELETE FROM user_sessions`;
      await sql.end({ timeout: 5 });
    }
  });
}
