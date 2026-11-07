import { createHash } from "node:crypto";
import { sql } from "../../db.js";
import { validateSourceUrl } from "../../skill-sources.js";

export class SkillSourceRegistrationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(readonly error_code: "SKILL_SOURCE_NAME_CONFLICT" | "SKILL_SOURCE_IDENTITY_AMBIGUOUS" | "SKILL_SOURCE_URL_INVALID") {
    super(error_code);
    this.code = error_code;
    this.statusCode = error_code === "SKILL_SOURCE_URL_INVALID" ? 400 : 409;
  }
}

/** GitHub's optional .git / slash / path case aliases; other hosts keep path case. */
export function canonicalSkillSourceIdentity(repoUrl: string, branch: string): string {
  let url: URL;
  try { url = new URL(repoUrl.trim()); }
  catch { throw new SkillSourceRegistrationError("SKILL_SOURCE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SkillSourceRegistrationError("SKILL_SOURCE_URL_INVALID");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (url.hostname === "github.com") pathname = pathname.replace(/\.git$/i, "").toLowerCase();
  const ref = branch.replace(/^refs\/heads\//, "");
  if (!pathname || !ref || ref !== ref.trim()) throw new SkillSourceRegistrationError("SKILL_SOURCE_URL_INVALID");
  return `${url.origin}${pathname}\n${ref}`;
}

/** Caller owns a short SQL transaction; every management registration shares this lock. */
export async function registerSkillSource(db: typeof sql, input: { name: string; repo_url: string; branch: string }) {
  try { validateSourceUrl(input.repo_url); }
  catch { throw new SkillSourceRegistrationError("SKILL_SOURCE_URL_INVALID"); }
  const identity = canonicalSkillSourceIdentity(input.repo_url, input.branch);
  const stored = { ...input, repo_url: new URL(input.repo_url.trim()).href,
    branch: input.branch.replace(/^refs\/heads\//, "") };
  const key = createHash("sha256").update(identity).digest("hex");
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-source-register:${key}`}, 0))`;
  const rows = await db`SELECT id, name, repo_url, branch FROM skill_sources ORDER BY id`;
  const matching = rows.filter((row) => {
    try { return canonicalSkillSourceIdentity(String(row.repo_url), String(row.branch)) === identity; }
    catch { return false; }
  });
  if (matching.length > 1) throw new SkillSourceRegistrationError("SKILL_SOURCE_IDENTITY_AMBIGUOUS");
  if (matching.length === 1) {
    const [existing] = await db`SELECT * FROM skill_sources WHERE id = ${String(matching[0]!.id)} FOR KEY SHARE`;
    if (!existing) throw new SkillSourceRegistrationError("SKILL_SOURCE_IDENTITY_AMBIGUOUS");
    return { row: existing, existing: true };
  }
  if (rows.some((row) => row.name === input.name)) throw new SkillSourceRegistrationError("SKILL_SOURCE_NAME_CONFLICT");
  try {
    const [row] = await db`INSERT INTO skill_sources ${db(stored)} RETURNING *`;
    if (!row) throw new Error("skill source registration did not return a row");
    return { row, existing: false };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new SkillSourceRegistrationError("SKILL_SOURCE_NAME_CONFLICT");
    }
    throw error;
  }
}
