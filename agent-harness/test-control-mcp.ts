/** 本地控制 MCP 协议冒烟：验证动态工具列表与 fact/done NDJSON 事件。 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_MCP_SERVER } from "../apps/scheduler/src/control-mcp.js";

const eventFile = join(tmpdir(), `dfh-control-mcp-${randomUUID()}.jsonl`);
const child = spawn(process.execPath, ["--input-type=module", "-e", CONTROL_MCP_SERVER], {
  env: {
    ...process.env,
    DFH_CONTROL_EVENT_FILE: eventFile,
    DFH_CONTROL_TOOL_NAMES: JSON.stringify(["emit_fact", "mark_job_done"]),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let replies = "";
child.stdout.on("data", (chunk) => {
  replies += chunk.toString();
});
const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
};

send(1, "initialize", { protocolVersion: "2024-11-05" });
send(2, "tools/list");
send(3, "tools/call", {
  name: "emit_fact",
  arguments: { title: "实时事实", description: "增量证据" },
});
send(4, "tools/call", {
  name: "mark_job_done",
  arguments: { summary: "完成" },
});

await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("MCP response timeout")), 5_000);
  const timer = setInterval(() => {
    if (replies.trim().split("\n").length >= 4) {
      clearTimeout(deadline);
      clearInterval(timer);
      resolve();
    }
  }, 25);
});
child.kill();

try {
  const events = readFileSync(eventFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  if (events.length !== 2 || events[0]?.type !== "fact" || events[1]?.type !== "done") {
    throw new Error(`unexpected events: ${JSON.stringify(events)}`);
  }
  console.log(JSON.stringify({ replies: replies.trim().split("\n").length, events: events.map((event) => event.type) }));
} finally {
  unlinkSync(eventFile);
}
