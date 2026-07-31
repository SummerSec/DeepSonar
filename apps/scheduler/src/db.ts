import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, { max: 10 });

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** 启动时自动 migrate up（ARCHITECTURE §17.2 纪律） */
export async function migrate(): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`.catch(() => []);
    if (done.length > 0) continue;
    const body = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
