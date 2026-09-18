import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LANGUAGE_SERVER_UNAVAILABLE_CODE,
  createLanguageServerAdapter,
  createMockLspTransport,
} from "./language-server-adapter.mjs";

const dir = await mkdtemp(path.join(tmpdir(), "ls-adapter-"));
await writeFile(path.join(dir, "compile_commands.json"), JSON.stringify([{ file: "a.cc", command: "clang -c a.cc", directory: dir }]));
await writeFile(path.join(dir, "a.cc"), "int main(){return 0;}\n");

const transport = createMockLspTransport(async (method) => {
  if (method === "textDocument/definition") {
    return [{ uri: `file://${dir}/a.cc`, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } } }];
  }
  return { contents: "int main()" };
});

const adapter = createLanguageServerAdapter({
  workspaceRoot: dir,
  jobId: "job-1",
  revision: "abc123",
  transport,
  limits: { max_calls_per_job: 2, timeout_ms: 1000, max_response_bytes: 1024 },
});

const ok = await adapter.run("definition", { path: "a.cc", line: 0, character: 4, compile_commands_path: "compile_commands.json" });
assert.equal(ok.is_finding, false);
assert.equal(ok.inconclusive, false);
assert.equal(ok.request_type, "definition");
assert.equal(ok.job_id, "job-1");
assert.match(ok.compile_commands_fingerprint, /^sha256:[a-f0-9]{64}$/);
assert.ok(ok.file_ranges.length === 1);
assert.ok(ok.evidence_ref.startsWith("lsp://"));

const missing = await createLanguageServerAdapter({
  workspaceRoot: dir,
  jobId: "job-1",
  revision: "abc123",
  transport,
}).run("hover", { path: "a.cc", compile_commands_path: "missing.json" });
assert.equal(missing.inconclusive, true);
assert.equal(missing.unavailable_code, LANGUAGE_SERVER_UNAVAILABLE_CODE);
assert.equal(missing.unavailable_reason, "missing_precondition");

const escape = await adapter.run("hover", { path: "../etc/passwd", compile_commands_path: "compile_commands.json" });
assert.equal(escape.unavailable_reason, "path_outside_workspace");

await adapter.run("hover", { path: "a.cc", compile_commands_path: "compile_commands.json" });
const budget = await adapter.run("hover", { path: "a.cc", compile_commands_path: "compile_commands.json" });
assert.equal(budget.unavailable_reason, "budget_exceeded");

const huge = createLanguageServerAdapter({
  workspaceRoot: dir,
  jobId: "job-2",
  revision: "r2",
  limits: { max_calls_per_job: 5, timeout_ms: 1000, max_response_bytes: 32 },
  transport: createMockLspTransport(async () => ({ pad: "x".repeat(200) })),
});
const truncated = await huge.run("hover", { path: "a.cc", compile_commands_path: "compile_commands.json" });
assert.equal(truncated.truncated, true);
assert.ok(truncated.truncation_notes.length > 0);
assert.equal(truncated.is_finding, false);

await rm(dir, { recursive: true, force: true });
console.log("language-server-adapter offline tests ok");
