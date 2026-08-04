import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { CONTROL_MCP_SERVER } from "./control-mcp.js";
import { ControlInputError } from "./control-input.js";
import { parseHubDecision } from "./graph.js";

const rootId = "00000000-0000-4000-8000-000000000001";
const otherCanvasId = "00000000-0000-4000-8000-000000000002";
const roles = new Set(["review"]);

function parseIntent(from: unknown) {
  return parseHubDecision(
    JSON.stringify({ intents: [{ from, role: "review", description: "复核", prompt: "执行复核" }] }),
    roles,
    [rootId],
  );
}

function assertInvalidNodeRef(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ControlInputError);
    assert.equal(error.code, "invalid_node_ref");
    assert.match(error.message, /YAML root_id/);
    assert.doesNotMatch(error.message, /invalid input syntax for type uuid/i);
    return true;
  });
}

test("Hub parser rejects root_id field names and non-UUID references", () => {
  assertInvalidNodeRef(() => parseIntent(["root_id"]));
  assertInvalidNodeRef(() => parseIntent(["not-a-uuid"]));
});

test("Hub parser accepts canonical UUIDs and rejects cross-canvas IDs", () => {
  const decision = parseIntent([rootId]);
  assert.equal(decision?.intents?.[0]?.from[0], rootId);
  assert.equal(parseIntent([])?.intents?.[0]?.from.length, 0);
  assertInvalidNodeRef(() => parseIntent([otherCanvasId]));
});

test("complete.from and missing references use the same stable rejection", () => {
  const complete = parseHubDecision(
    JSON.stringify({ complete: { from: [rootId], description: "完成" } }),
    roles,
    [rootId],
  );
  assert.equal(complete?.complete?.from[0], rootId);
  assertInvalidNodeRef(() =>
    parseHubDecision(JSON.stringify({ complete: { description: "缺少引用" } }), roles, [rootId]),
  );
});

interface McpResponse {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

async function callControlMcp(requests: unknown[]): Promise<McpResponse[]> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CONTROL_MCP_SERVER], {
    env: {
      ...process.env,
      DEEPSONAR_CONTROL_TOOL_NAMES: JSON.stringify(["submit_hub_decision"]),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = createInterface({ input: child.stdout });
  try {
    const responses: McpResponse[] = [];
    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const line = await new Promise<string>((resolve, reject) => {
        const onLine = (value: string) => {
          cleanup();
          resolve(value);
        };
        const onExit = () => {
          cleanup();
          reject(new Error("control MCP exited before replying"));
        };
        const cleanup = () => {
          rl.removeListener("line", onLine);
          child.removeListener("exit", onExit);
        };
        rl.once("line", onLine);
        child.once("exit", onExit);
      });
      responses.push(JSON.parse(line) as McpResponse);
    }
    return responses;
  } finally {
    rl.close();
    child.kill();
  }
}

test("control MCP advertises and rejects invalid Hub references before accepted event", async () => {
  const [listed, invalid, valid] = await callControlMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "submit_hub_decision", arguments: { intents: [{ from: ["root_id"], role: "review", description: "x", prompt: "y" }] } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "submit_hub_decision", arguments: { intents: [{ from: [rootId], role: "review", description: "x", prompt: "y" }] } },
    },
  ]);
  const tool = (listed.result?.content ?? [])[0];
  assert.ok(tool || listed.result);
  const listedText = JSON.stringify(listed);
  assert.match(CONTROL_MCP_SERVER, /format: "uuid"/);
  assert.match(CONTROL_MCP_SERVER, /pattern: CANONICAL_UUID_PATTERN/);
  assert.equal(invalid.result?.isError, true);
  assert.match(invalid.result?.content?.[0]?.text ?? "", /invalid_node_ref/);
  assert.equal(valid.result?.isError, undefined);
  assert.match(listedText, /submit_hub_decision/);
});
