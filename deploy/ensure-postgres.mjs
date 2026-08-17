import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const deployDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(deployDir, "..");
const envFile = path.join(deployDir, ".env");

if (!existsSync(envFile)) {
  console.error("[db:up:deploy] missing deploy/.env; start the deploy stack first (deploy.ps1 / deploy.sh up)");
  process.exit(1);
}

execFileSync(
  "docker",
  [
    "compose",
    "-p",
    "deepsonar",
    "--env-file",
    envFile,
    "-f",
    path.join(deployDir, "docker-compose.prod.yml"),
    "up",
    "-d",
    "postgres",
  ],
  { stdio: "inherit", cwd: repoRoot, windowsHide: true },
);

function readEnv(file) {
  const map = {};
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) map[match[1]] = match[2];
  }
  return map;
}

const password = readEnv(envFile).POSTGRES_PASSWORD?.trim();
if (!password) {
  console.error("[db:up:deploy] POSTGRES_PASSWORD missing in deploy/.env");
  process.exit(1);
}

const url = `postgres://deepsonar:${encodeURIComponent(password)}@127.0.0.1:5432/deepsonar`;
const rootEnv = path.join(repoRoot, ".env");
if (existsSync(rootEnv)) {
  let raw = readFileSync(rootEnv, "utf8");
  if (/^DATABASE_URL=/m.test(raw)) raw = raw.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`);
  else raw = `${raw.trimEnd()}\nDATABASE_URL=${url}\n`;
  writeFileSync(rootEnv, raw);
  console.log("[db:up:deploy] synced .env DATABASE_URL to compose postgres on 127.0.0.1:5432");
}

console.log("[db:up:deploy] using compose project deepsonar (deepsonar-postgres-1)");
console.log("[db:up:deploy] 5432 is shared; stop this host publish or the container before pnpm db:up");
console.log("[db:up:deploy] do not run pnpm dev and the compose scheduler on this database at the same time");
