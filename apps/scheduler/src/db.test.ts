import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateOnReservedSession, type ReservedMigrationConnection } from "./db.js";

function fakeReservedConnection(lockError?: Error): {
  connection: ReservedMigrationConnection;
  unlocks: number;
  releases: number;
} {
  let unlocks = 0;
  let releases = 0;
  const connection = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const query = strings.join(" ");
    if (query.includes("pg_advisory_lock") && lockError) throw lockError;
    if (query.includes("pg_advisory_unlock")) unlocks += 1;
    return [];
  }) as unknown as ReservedMigrationConnection;
  connection.unsafe = async () => undefined;
  connection.release = () => {
    releases += 1;
  };
  return {
    connection,
    get unlocks() {
      return unlocks;
    },
    get releases() {
      return releases;
    },
  };
}

test("migration lock acquisition failure always releases the reserved connection", async () => {
  const failure = new Error("lock acquisition failed");
  const fake = fakeReservedConnection(failure);
  await assert.rejects(
    migrateOnReservedSession(async () => fake.connection, async () => []),
    /lock acquisition failed/,
  );
  assert.equal(fake.unlocks, 0);
  assert.equal(fake.releases, 1);
});

test("migration lock is released before a successful reserved connection release", async () => {
  const fake = fakeReservedConnection();
  await migrateOnReservedSession(async () => fake.connection, async () => ["ok"]);
  assert.equal(fake.unlocks, 1);
  assert.equal(fake.releases, 1);
});
