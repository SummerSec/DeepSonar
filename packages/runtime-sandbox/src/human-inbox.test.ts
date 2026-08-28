import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HUMAN_INBOX_WRITER_SCRIPT, parseHumanInboxWorkspacePath } from "./runtime-shared.js";

test("human inbox path parser rejects paths outside its exact message directory shape", () => {
  for (const value of [
    "/workspace/file.txt",
    "/workspace/.deepsonar/inbox/not-a-uuid/file.txt",
    "/workspace/.deepsonar/inbox/11111111-1111-4111-8111-111111111111/../secret",
  ]) {
    assert.throws(() => parseHumanInboxWorkspacePath(value), /path_forbidden/u);
  }
  assert.deepEqual(
    parseHumanInboxWorkspacePath("/workspace/.deepsonar/inbox/11111111-1111-4111-8111-111111111111/evidence.bin"),
    { messageId: "11111111-1111-4111-8111-111111111111", filename: "evidence.bin" },
  );
});

test("human inbox command protocol is descriptor-relative and never uses uploadFile", () => {
  assert.match(HUMAN_INBOX_WRITER_SCRIPT, /os\.O_NOFOLLOW/u);
  assert.match(HUMAN_INBOX_WRITER_SCRIPT, /dir_fd=current/u);
  assert.match(HUMAN_INBOX_WRITER_SCRIPT, /os\.O_EXCL/u);
  assert.deepEqual([...HUMAN_INBOX_WRITER_SCRIPT.matchAll(/os\.open\(/gu)].length >= 3, true);
  assert.doesNotMatch(HUMAN_INBOX_WRITER_SCRIPT, /(?:realpath|follow_symlinks\s*=\s*True)/u);
});

function runInboxProtocol(workspace: string, messageId: string, filename: string, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile("python3", ["-c", HUMAN_INBOX_WRITER_SCRIPT, workspace, messageId, filename], (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(bytes);
  });
}

test("real inbox command rejects every symlink boundary and writes only the descriptor-opened target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-human-inbox-"));
  const messageId = "11111111-1111-4111-8111-111111111111";
  try {
    for (const boundary of ["deepsonar", "inbox", "message", "target"] as const) {
      const workspace = path.join(root, boundary, "workspace");
      const outside = path.join(root, boundary, "outside");
      await mkdir(workspace, { recursive: true });
      await mkdir(outside, { recursive: true });
      if (boundary === "deepsonar") await symlink(outside, path.join(workspace, ".deepsonar"));
      else {
        await mkdir(path.join(workspace, ".deepsonar"), { recursive: true });
        if (boundary === "inbox") await symlink(outside, path.join(workspace, ".deepsonar", "inbox"));
        else {
          await mkdir(path.join(workspace, ".deepsonar", "inbox"), { recursive: true });
          if (boundary === "message") await symlink(outside, path.join(workspace, ".deepsonar", "inbox", messageId));
          else {
            await mkdir(path.join(workspace, ".deepsonar", "inbox", messageId), { recursive: true });
            const victim = path.join(outside, "victim.bin");
            await writeFile(victim, "unchanged");
            await symlink(victim, path.join(workspace, ".deepsonar", "inbox", messageId, "evidence.bin"));
          }
        }
      }
      await assert.rejects(runInboxProtocol(workspace, messageId, "evidence.bin", Buffer.from("secret")));
      if (boundary === "target") assert.equal(await readFile(path.join(outside, "victim.bin"), "utf8"), "unchanged");
    }

    const cleanWorkspace = path.join(root, "clean", "workspace");
    await mkdir(cleanWorkspace, { recursive: true });
    await runInboxProtocol(cleanWorkspace, messageId, "evidence.bin", Buffer.from("expected"));
    assert.equal(await readFile(path.join(cleanWorkspace, ".deepsonar", "inbox", messageId, "evidence.bin"), "utf8"), "expected");
    await assert.rejects(runInboxProtocol(cleanWorkspace, messageId, "evidence.bin", Buffer.from("replacement")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
