import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("login rate-limit integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("loginUser counts every verification and serializes concurrent consumes", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const { createUser, loginUser, updateUser } = await import("./users.js");
    const {
      LOGIN_IP_ATTEMPT_LIMIT,
      LoginRateLimitError,
      consumeLoginAttempt,
      loginIdentityKey,
      loginRateLimitKey,
    } = await import("./login-rate-limit.js");
    await migrate();

    const password = `${randomUUID()}A!`;
    const username = `loginrl-${randomUUID().slice(0, 8)}`;
    const unknown = `missing-${randomUUID().slice(0, 8)}`;
    const disabledName = `disabled-${randomUUID().slice(0, 8)}`;
    const ip = `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
    const now = new Date("2026-08-16T12:00:00.000Z");
    const created: string[] = [];

    const rejectCode = async (op: () => Promise<unknown>, code: string) => {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error);
        assert.equal((error as { code: string }).code, code);
        if (code === "BAD_CREDENTIALS") {
          assert.equal(error instanceof Error && error.message, "用户名或密码错误");
        }
        return true;
      });
    };

    try {
      const user = await createUser({ username, password, role: "viewer" });
      created.push(user.id);
      const disabled = await createUser({ username: disabledName, password, role: "viewer" });
      created.push(disabled.id);
      await updateUser(disabled.id, { status: "disabled" });

      for (let i = 0; i < 4; i += 1) {
        await rejectCode(() => loginUser(username, "wrong-password", { ip }, now), "BAD_CREDENTIALS");
      }
      const fifth = await loginUser(username, password, { ip }, now);
      assert.equal(fifth.user.username, username);
      await assert.rejects(
        () => loginUser(username, password, { ip }, now),
        (error: unknown) => error instanceof LoginRateLimitError,
        "successful login consumes a slot and does not clear the bucket",
      );

      const otherIp = `${ip}.9`;
      const otherHost = await loginUser(username, password, { ip: otherIp }, now);
      assert.equal(otherHost.user.username, username, "same account from another IP has its own 5-slot bucket");

      const later = new Date(now.getTime() + 5 * 60 * 1000);
      const afterWindow = await loginUser(username, password, { ip }, later);
      assert.equal(afterWindow.user.username, username);

      for (let i = 0; i < 5; i += 1) {
        await rejectCode(() => loginUser(unknown, "wrong-password", { ip: `${ip}.1` }, now), "BAD_CREDENTIALS");
      }
      await assert.rejects(
        () => loginUser(unknown, "wrong-password", { ip: `${ip}.1` }, now),
        (error: unknown) => {
          assert.ok(error instanceof LoginRateLimitError);
          assert.equal(error.message, "登录尝试过于频繁，请稍后再试");
          return true;
        },
      );

      for (let i = 0; i < 5; i += 1) {
        await rejectCode(
          () => loginUser(disabledName, password, { ip: `${ip}.2` }, now),
          "BAD_CREDENTIALS",
        );
      }
      await assert.rejects(
        () => loginUser(disabledName, password, { ip: `${ip}.2` }, now),
        (error: unknown) => error instanceof LoginRateLimitError,
        "disabled accounts consume slots and then hit the same limiter",
      );

      const sprayIp = `198.51.100.${1 + Math.floor(Math.random() * 200)}`;
      for (let i = 0; i < LOGIN_IP_ATTEMPT_LIMIT; i += 1) {
        const consumed = await consumeLoginAttempt({
          username: `spray-${i}-${randomUUID().slice(0, 6)}`,
          ip: sprayIp,
          now,
        });
        assert.equal(consumed.limited, false);
      }
      const sprayed = await consumeLoginAttempt({
        username: `fresh-${randomUUID().slice(0, 6)}`,
        ip: sprayIp,
        now,
      });
      assert.equal(sprayed.limited, true);
      await assert.rejects(
        () => loginUser(username, password, { ip: sprayIp }, now),
        (error: unknown) => error instanceof LoginRateLimitError,
        "IP lock also rejects a correct password",
      );

      const raceUser = `race-${randomUUID().slice(0, 8)}`;
      const raceIp = `192.0.2.${1 + Math.floor(Math.random() * 200)}`;
      const raced = await createUser({ username: raceUser, password, role: "viewer" });
      created.push(raced.id);
      const concurrent = await Promise.allSettled(
        Array.from({ length: 8 }, () => loginUser(raceUser, password, { ip: raceIp }, now)),
      );
      assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 5);
      assert.equal(concurrent.filter((result) => result.status === "rejected").length, 3);
      assert.ok(concurrent.filter((result) => result.status === "rejected").every(
        (result) => result.status === "rejected" && result.reason instanceof LoginRateLimitError,
      ));
      const [identityRow] = await sql<{ attempt_count: number }[]>`
        SELECT attempt_count FROM login_rate_limits
        WHERE scope = 'identity' AND key = ${loginIdentityKey(raceUser, raceIp)}`;
      const [ipRow] = await sql<{ attempt_count: number }[]>`
        SELECT attempt_count FROM login_rate_limits
        WHERE scope = 'ip' AND key = ${loginRateLimitKey("ip", raceIp)}`;
      assert.equal(identityRow?.attempt_count, 5);
      assert.equal(ipRow?.attempt_count, 5);
    } finally {
      if (created.length) {
        await sql`DELETE FROM user_sessions WHERE user_id IN ${sql(created)}`;
        await sql`DELETE FROM users WHERE id IN ${sql(created)}`;
      }
      await sql`DELETE FROM login_rate_limits`;
      await sql.end({ timeout: 5 });
    }
  });
}
