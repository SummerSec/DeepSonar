import postgres from "postgres";
import type { MigrationConnection } from "./migration-runner.js";
import { runUpgradeSchema, type UpgradeSchemaRequest } from "./platform-upgrade-schema-runner.js";

// Connection fields exist only in stdin and process memory. Never print driver errors.
let connection: ReturnType<typeof postgres> | undefined;
try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("INPUT_LIMIT");
  }
  const input = JSON.parse(raw) as UpgradeSchemaRequest & {schema: string; connection: {host: string; port: number; username: string; password: string; database: string}};
  if (input.schema !== "deepsonar.schema-upgrade/v1" || !input.connection || input.connection.database !== (input.action === "plan" ? (input.source_database ?? input.candidate_database) : input.candidate_database)) throw new Error("INVALID_INPUT");
  const {host, port, username, password, database} = input.connection;
  if (typeof host !== "string" || !Number.isInteger(port) || port < 1 || port > 65535 || typeof username !== "string" || typeof password !== "string") throw new Error("INVALID_CONNECTION");
  connection = postgres({host, port, username, password, database, max: 1, connect_timeout: 10, onnotice: () => {},
    connection: {application_name: "deepsonar-upgrade-candidate"}});
  const reserved = await connection.reserve();
  try {
    const result = await runUpgradeSchema(reserved as unknown as MigrationConnection, input);
    process.stdout.write(JSON.stringify({schema: "deepsonar.schema-upgrade-result/v1", ...result}) + "\n");
    process.exitCode = result.ok ? 0 : 1;
  } finally { reserved.release(); }
} catch {
  process.stdout.write(JSON.stringify({schema: "deepsonar.schema-upgrade-result/v1", ok: false, applied: false,
    blocking_errors: [{code: "CANDIDATE_SCHEMA_OPERATION_FAILED"}]}) + "\n");
  process.exitCode = 1;
} finally { await connection?.end({timeout: 5}); }
