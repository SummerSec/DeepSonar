/**
 * 平台用户认证：用户名密码 + 会话 Token
 * - 密码：scrypt 派生，库中只存 salt + hash
 * - 会话：deepsonar_user_<env>_<prefix>_<secret>，库中只存 sha256
 * - 角色 → scopes：admin / operator / viewer
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { sql } from "./db.js";
import { consumeLoginAttempt, LoginRateLimitError } from "./login-rate-limit.js";

export type UserRole = "admin" | "operator" | "viewer";

/** Public, first-run credentials for local/demo installations. Production must rotate them immediately. */
export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "Deep@Sonar66";
const DEFAULT_ADMIN_SEED_LOCK_ID = 726868002;

export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: "active" | "disabled";
  last_login_at: string | null;
  created_at: string;
}

const OPERATOR_SCOPES = [
  "projects:read",
  "projects:write",
  "tasks:read",
  "tasks:write",
  "jobs:control",
  "findings:read",
  "findings:write",
  "skills:read",
  "skills:write",
  "agents:read",
  "agents:write",
  "integrations:read",
  "integrations:write",
  "exports:read",
  "exports:write",
  "imports:read",
  "imports:write",
];

const VIEWER_SCOPES = [
  "projects:read",
  "tasks:read",
  "findings:read",
  "skills:read",
  "agents:read",
  "integrations:read",
  "exports:read",
  "imports:read",
];

export function scopesForRole(role: UserRole): string[] {
  // admin 隐式拥有全部（authHook 对 admin scope 放行）
  if (role === "admin") return ["admin"];
  if (role === "viewer") return [...VIEWER_SCOPES];
  return [...OPERATOR_SCOPES];
}

export function hashPassword(password: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function verifyPassword(password: string, saltHex: string, hashHex: string): boolean {
  try {
    const { hash } = hashPassword(password, saltHex);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(hashHex, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Constant-cost dummy so missing usernames are not a cheap oracle vs scrypt. */
const LOGIN_DUMMY_SALT = "00".repeat(16);
const LOGIN_DUMMY_HASH = hashPassword("deepsonar-login-dummy", LOGIN_DUMMY_SALT).hash;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeUsername(input: string): string {
  const username = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) {
    throw Object.assign(new Error("用户名仅允许小写字母数字与 ._-，2–64 字符"), { code: "BAD_USERNAME" });
  }
  return username;
}

/** 生成用户会话明文；prefix 用于查库 */
export function generateSessionToken(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `deepsonar_user_${config.auth.tokenEnv}_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashSessionToken(plaintext) };
}

export function parseSessionToken(token: string): string | null {
  const m = token.match(/^deepsonar_user_[a-z0-9]+_([0-9a-f]{8})_[A-Za-z0-9_-]{16,}$/);
  return m?.[1] ?? null;
}

export function toPublicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: row.id as string,
    username: row.username as string,
    display_name: (row.display_name as string) || (row.username as string),
    role: row.role as UserRole,
    status: row.status as "active" | "disabled",
    last_login_at: (row.last_login_at as string) ?? null,
    created_at: row.created_at as string,
  };
}

export async function countUsers(): Promise<number> {
  const [r] = await sql`SELECT COUNT(*)::int AS n FROM users`;
  return (r?.n as number) ?? 0;
}

/** True only while the public first-run credentials still work for an active admin row. */
export async function defaultAdminCredentialsActive(): Promise<boolean> {
  const [row] = await sql`
    SELECT password_salt, password_hash
    FROM users
    WHERE username = ${DEFAULT_ADMIN_USERNAME} AND status = 'active'`;
  return Boolean(
    row && verifyPassword(DEFAULT_ADMIN_PASSWORD, row.password_salt as string, row.password_hash as string),
  );
}

/**
 * Seed the public first-run admin exactly once. The transaction advisory lock
 * serializes multiple scheduler instances during boot; existing users always
 * win, so a restart can never reset a password or recreate the account.
 */
export async function ensureDefaultAdmin(): Promise<{ created: boolean; user: PublicUser | null }> {
  let created = false;
  let user: PublicUser | null = null;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${DEFAULT_ADMIN_SEED_LOCK_ID})`;
    const [count] = await tx`SELECT COUNT(*)::int AS n FROM users`;
    if (Number(count?.n ?? 0) > 0) return;

    const { salt, hash } = hashPassword(DEFAULT_ADMIN_PASSWORD);
    const [row] = await tx`
      INSERT INTO users ${tx({
        username: DEFAULT_ADMIN_USERNAME,
        display_name: DEFAULT_ADMIN_USERNAME,
        password_hash: hash,
        password_salt: salt,
        role: "admin",
        status: "active",
        created_by: "system:default-admin",
      })}
      RETURNING *`;
    if (!row) throw new Error("默认管理员创建失败");
    user = toPublicUser(row as Record<string, unknown>);
    created = true;

    // Startup has no Fastify request context. Keep the audit append-only and
    // include only safe identity metadata (never the seed password/hash).
    await tx`
      INSERT INTO audit_logs (
        actor_type, actor_id, action, resource_type, resource_id, after_json
      ) VALUES (
        'system', 'scheduler', 'auth.default_admin_seed', 'user', ${user.id},
        ${tx.json({ username: user.username, role: user.role } as never)}
      )`;
  });
  return { created, user };
}

export async function createUser(input: {
  username: string;
  password: string;
  display_name?: string;
  role?: UserRole;
  created_by?: string | null;
}): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  if (input.password.length < 8) {
    throw Object.assign(new Error("密码至少 8 位"), { code: "WEAK_PASSWORD" });
  }
  const { salt, hash } = hashPassword(input.password);
  try {
    const [row] = await sql`
      INSERT INTO users ${sql({
        username,
        display_name: input.display_name?.trim() || username,
        password_hash: hash,
        password_salt: salt,
        role: input.role ?? "operator",
        status: "active",
        created_by: input.created_by ?? null,
      })}
      RETURNING *`;
    return toPublicUser(row as Record<string, unknown>);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "23505") {
      throw Object.assign(new Error("用户名已存在"), { code: "USERNAME_TAKEN" });
    }
    throw e;
  }
}

/** Issue a session for an already-authenticated active user (change-password / change-username). */
export async function issueUserSession(
  userId: string,
  meta?: { ip?: string; userAgent?: string },
): Promise<{ user: PublicUser; token: string; expires_at: string }> {
  const [row] = await sql`SELECT * FROM users WHERE id = ${userId}`;
  if (!row || row.status !== "active") {
    throw Object.assign(new Error("账号已禁用"), { code: "DISABLED" });
  }
  const sess = generateSessionToken();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 天
  await sql`
    INSERT INTO user_sessions ${sql({
      user_id: row.id as string,
      token_prefix: sess.prefix,
      token_hash: sess.hash,
      expires_at: expires.toISOString(),
      last_ip: meta?.ip ?? null,
      user_agent: meta?.userAgent?.slice(0, 500) ?? null,
    })}`;
  await sql`UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = ${row.id as string}`;
  return {
    user: toPublicUser(row as Record<string, unknown>),
    token: sess.plaintext,
    expires_at: expires.toISOString(),
  };
}

export async function loginUser(
  username: string,
  password: string,
  meta?: { ip?: string; userAgent?: string },
  now: Date = new Date(),
): Promise<{ user: PublicUser; token: string; expires_at: string }> {
  const uname = username.trim().toLowerCase();
  const [row] = await sql`SELECT * FROM users WHERE username = ${uname}`;
  // Always pay scrypt (real or dummy) before any cheap lockout return.
  const passwordOk = verifyPassword(
    password,
    row ? (row.password_salt as string) : LOGIN_DUMMY_SALT,
    row ? (row.password_hash as string) : LOGIN_DUMMY_HASH,
  );
  // Consume after scrypt so 429 is not cheaper than 401 / dummy verify.
  const consumption = await consumeLoginAttempt({ username: uname, ip: meta?.ip, now });
  if (consumption.limited) {
    throw new LoginRateLimitError(consumption.retryAfterSec);
  }
  if (!row || row.status !== "active" || !passwordOk) {
    throw Object.assign(new Error("用户名或密码错误"), { code: "BAD_CREDENTIALS" });
  }
  return issueUserSession(row.id as string, meta);
}

export async function resolveSessionToken(token: string): Promise<{
  user: PublicUser;
  sessionId: string;
  scopes: string[];
} | null> {
  const prefix = parseSessionToken(token);
  if (!prefix) return null;
  const [sess] = await sql`
    SELECT s.id AS session_id, s.token_hash, s.expires_at, s.revoked_at,
           u.id, u.username, u.display_name, u.role, u.status, u.last_login_at, u.created_at
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_prefix = ${prefix}`;
  if (!sess) return null;
  if (sess.revoked_at) return null;
  if (new Date(sess.expires_at as string).getTime() < Date.now()) return null;
  if (sess.status !== "active") return null;

  const a = Buffer.from(sess.token_hash as string, "utf8");
  const b = Buffer.from(hashSessionToken(token), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  void sql`UPDATE user_sessions SET last_used_at = now() WHERE id = ${sess.session_id as string}`.catch(() => {});

  const user = toPublicUser(sess as Record<string, unknown>);
  return {
    user,
    sessionId: sess.session_id as string,
    scopes: scopesForRole(user.role),
  };
}

export async function revokeSession(token: string): Promise<boolean> {
  const prefix = parseSessionToken(token);
  if (!prefix) return false;
  const [row] = await sql`
    UPDATE user_sessions SET revoked_at = now()
    WHERE token_prefix = ${prefix} AND revoked_at IS NULL
    RETURNING id`;
  return Boolean(row);
}

export async function revokeAllUserSessions(userId: string): Promise<number> {
  const rows = await sql`
    UPDATE user_sessions SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length;
}

export async function listUsers(): Promise<PublicUser[]> {
  const rows = await sql`SELECT * FROM users ORDER BY created_at ASC`;
  return rows.map((r) => toPublicUser(r as Record<string, unknown>));
}

export async function setUserPassword(userId: string, password: string): Promise<void> {
  if (password.length < 8) {
    throw Object.assign(new Error("密码至少 8 位"), { code: "WEAK_PASSWORD" });
  }
  const { salt, hash } = hashPassword(password);
  await sql`
    UPDATE users SET password_hash = ${hash}, password_salt = ${salt}, updated_at = now()
    WHERE id = ${userId}`;
  await revokeAllUserSessions(userId);
}

export async function setUserUsername(userId: string, usernameInput: string): Promise<PublicUser | null> {
  const username = normalizeUsername(usernameInput);
  try {
    const [row] = await sql`
      UPDATE users SET username = ${username}, updated_at = now()
      WHERE id = ${userId}
      RETURNING *`;
    if (!row) return null;
    await revokeAllUserSessions(userId);
    return toPublicUser(row as Record<string, unknown>);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "23505") {
      throw Object.assign(new Error("用户名已存在"), { code: "USERNAME_TAKEN" });
    }
    throw e;
  }
}

export async function updateUser(
  userId: string,
  patch: { display_name?: string; role?: UserRole; status?: "active" | "disabled" },
): Promise<PublicUser | null> {
  const [cur] = await sql`SELECT * FROM users WHERE id = ${userId}`;
  if (!cur) return null;
  const [row] = await sql`
    UPDATE users SET
      display_name = ${patch.display_name ?? (cur.display_name as string)},
      role = ${patch.role ?? (cur.role as string)},
      status = ${patch.status ?? (cur.status as string)},
      updated_at = now()
    WHERE id = ${userId}
    RETURNING *`;
  if (patch.status === "disabled") await revokeAllUserSessions(userId);
  return row ? toPublicUser(row as Record<string, unknown>) : null;
}
