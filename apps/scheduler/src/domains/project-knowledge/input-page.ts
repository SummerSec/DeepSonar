import { KNOWLEDGE_LIMITS } from "@deepsonar/shared-types";
import { canonical, reject, sha256 } from "./types.js";

/** A cursor grants no extra data: every page is authorized again by its caller. */
export function pageKnowledgeInput(value: unknown, scope: string, cursor?: string) {
  const bytes = Buffer.from(canonical(value), "utf8"), context = sha256(scope);
  let offset = 0;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (parsed.context !== context || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset >= bytes.length)
        throw new Error("invalid cursor");
      offset = parsed.offset;
      if ((bytes[offset]! & 0xc0) === 0x80) throw new Error("invalid UTF8 boundary");
    } catch { return reject("KNOWLEDGE_CURSOR_INVALID", "Input cursor does not match the current frozen input"); }
  }
  let end = Math.min(bytes.length, offset + KNOWLEDGE_LIMITS.readBytes);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { encoding: "json-utf8", content_fragment: bytes.subarray(offset, end).toString("utf8"),
    total_bytes: bytes.length, next_cursor: end < bytes.length ? Buffer.from(JSON.stringify({ context, offset: end })).toString("base64url") : null };
}
