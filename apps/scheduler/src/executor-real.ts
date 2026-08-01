import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRealAgent } from "@dfh/runtime-sandbox";
import { FindingPayload } from "@dfh/shared-types";
import { config } from "./config.js";
import { ingestEvent, type AgentProfileSnapshot } from "./core.js";
import { sql } from "./db.js";
import { publishStream } from "./stream-bus.js";

/**
 * 真实 Agent 执行器（ARCHITECTURE §8）
 * 契约：agent 在沙箱内审计 /workspace/src，
 *   findings → /workspace/findings.jsonl（每行一个 SARIF 子集 JSON）
 *   总结    → /workspace/done.json（{"summary": "...", "verdict": "..."?}）
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO_REPO = path.join(REPO_ROOT, "agent-harness", "demo-repo");

/** 读取演示仓库 → 种子文件映射（/workspace/src/<rel> → content） */
function seedFilesFromDir(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, seedFilesFromDir(full, rel));
    else out[`/workspace/src/${rel}`] = readFileSync(full, "utf8");
  }
  return out;
}

const AUDIT_PROMPT = (modulePath?: string) => `你是一个白盒安全审计专家。代码在 /workspace/src${modulePath ? `（重点审计 ${modulePath}）` : ""}。

要求：
1. 通读代码，找出真实可利用的安全漏洞（SQL 注入、XSS、路径穿越、任意文件上传、硬编码密钥、危险函数等）
2. 每个漏洞写一行 JSON 到 /workspace/findings.jsonl（JSONL 格式，每行一个对象）：
   {"title":"...","severity":"low|medium|high|critical","location":"相对路径:行号","summary":"成因与利用方式（中文，100 字内）","rule_id":"规则标识","suggest_verify":true}
3. 只报告有把握的洞，宁缺毋滥；location 必须精确到行
4. 完成后写 /workspace/done.json：{"summary":"审计总结（中文，200 字内，含漏洞数量与最高级别）"}
   必须是纯 JSON 文件，不要用 markdown 代码围栏包裹
5. 不要修改源代码，不要输出 findings.jsonl 以外的漏洞报告`;

const VERIFY_PROMPT = (finding: { title: string; location?: string; summary?: string }) => `你是一个漏洞验证专家。代码在 /workspace/src。请验证以下审计发现是否真实成立：

标题：${finding.title}
位置：${finding.location ?? "未知"}
描述：${finding.summary ?? "无"}

要求：
1. 阅读相关代码，静态分析该漏洞是否真实存在、是否可利用
2. 写 /workspace/done.json：{"summary":"验证过程与结论（中文，150 字内）","verdict":"confirmed|false_positive|needs_human"}
   - confirmed=确认真实可利用；false_positive=误报；needs_human=无法确定需人工
   - verdict 字段只能是这三个英文词之一，不要带任何括号注释；文件必须是纯 JSON，不要用 markdown 代码围栏包裹
3. 不要修改源代码`;

export async function executeReal(jobId: string, type: string): Promise<void> {
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`job ${jobId} 不存在`);

  const emit = (t: "progress" | "finding" | "done", payload: unknown) =>
    ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: t, payload });

  const isVerify = type === "verify_finding";
  const payload = job.payload_json as Record<string, unknown>;

  // Agent 配置：job 冻结的 profile 快照优先，无快照退回 env 全局配置（§8.1 下一 job 生效）
  const snapshot = (job.agent_snapshot_json as AgentProfileSnapshot | null) ?? null;
  const cliName = snapshot?.agent_cli ?? config.runtime.agentProvider;
  const provider = (cliName === "opencode" ? "open-code" : cliName) as "claude-code" | "open-code" | "codex";
  const model = snapshot?.model ?? config.runtime.agentModel ?? undefined;
  // env_keys 只存变量名引用，值运行时从调度器 process.env 解析（密钥不落库，§9）
  const env: Record<string, string> = { ...config.runtime.agentEnv };
  for (const key of snapshot?.env_keys ?? []) {
    const v = process.env[key];
    if (v) env[key] = v;
  }

  const basePrompt = isVerify
    ? VERIFY_PROMPT((payload.finding ?? {}) as { title: string; location?: string; summary?: string })
    : AUDIT_PROMPT(payload.module_path as string | undefined);
  const prompt = snapshot?.prompt_suffix ? `${basePrompt}\n\n${snapshot.prompt_suffix}` : basePrompt;

  await emit("progress", {
    message: `真实 agent 启动（${provider}${snapshot ? ` / profile=${snapshot.name}` : " / env 全局配置"}）`,
  });

  // 工具输入 → 一行动作描述（节点「当前动作」+ 实时流卡片共用）
  const actionOf = (toolName: string, input: unknown): string => {
    const o = (input ?? {}) as Record<string, unknown>;
    const target =
      (o.file_path as string) ?? (o.command as string) ?? (o.pattern as string) ??
      (o.path as string) ?? (o.url as string) ?? "";
    return `${toolName}${target ? ` ${String(target).slice(0, 80)}` : ""}`;
  };
  // 「当前动作」直接更新节点显示态（throttle 1.5s；非语义事件，不进 events 表）
  let lastActionPush = 0;

  const result = await runRealAgent(
    { sandboxId: job.sandbox_id as string },
    {
      provider,
      model,
      env,
      prompt,
      // Agent 配置下发（skills/commands/mcps/subAgents 随 setup 差量上传）
      skills: snapshot?.skills as never,
      commands: snapshot?.commands as never,
      mcps: snapshot?.mcps as never,
      subAgents: snapshot?.subagents as never,
      // 审计任务注入演示仓库；验证任务复用同一演示仓库（MVP：finding 上下文从种子代码来）
      seedFiles: seedFilesFromDir(DEMO_REPO),
      resultFiles: ["/workspace/findings.jsonl", "/workspace/done.json"],
      onProgress: (message) => {
        void emit("progress", { message }).catch(() => {});
      },
      onEvent: (e) => {
        const type = String(e.type ?? "");
        // 实时流：选择性字段转发（输入/输出可能很大，只取摘要）
        if (type === "tool.call.started") {
          const toolName = String(e.toolName ?? "tool");
          const action = actionOf(toolName, e.input);
          publishStream(jobId, { type, toolName, action });
          const now = Date.now();
          if (now - lastActionPush > 1500) {
            lastActionPush = now;
            void sql`
              UPDATE canvas_nodes SET body_json = body_json || ${sql.json({ last_progress: { message: action, kind: "tool" } })}, updated_at = now()
              WHERE job_id = ${jobId} AND node_type = 'job'`.catch(() => {});
          }
        } else if (type === "tool.call.completed") {
          publishStream(jobId, { type, toolName: e.toolName, callId: e.callId });
        } else if (type === "text.delta" || type === "reasoning.delta") {
          publishStream(jobId, { type, delta: String(e.delta ?? "").slice(0, 500) });
        } else if (type.startsWith("run.") || type.startsWith("message.")) {
          publishStream(jobId, { type, text: typeof e.text === "string" ? e.text.slice(0, 300) : undefined });
        }
      },
    },
  );

  if (result.error) throw new Error(`agent 运行失败: ${result.error}`);

  // findings 落库（schema 校验 + 上限 20 条/§4.3 护栏语义）
  let findingCount = 0;
  const lines = (result.files["/workspace/findings.jsonl"] ?? "").split("\n").filter((l) => l.trim());
  for (const line of lines.slice(0, 20)) {
    try {
      const f = FindingPayload.parse(JSON.parse(line));
      await emit("finding", f);
      findingCount++;
    } catch (e) {
      console.warn(`[real-agent] 跳过非法 finding 行:`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }

  let summary = result.text.slice(0, 500);
  let verdict: string | undefined;
  const doneRaw = result.files["/workspace/done.json"] ?? "";
  try {
    // 容错：剥掉模型可能加的 markdown 代码围栏
    const cleaned = doneRaw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const done = JSON.parse(cleaned || "{}") as {
      summary?: string;
      verdict?: string;
    };
    if (done.summary) summary = done.summary;
    verdict = done.verdict;
  } catch {
    // done.json 缺失/非法则用 agent 文本兜底
  }
  // verdict 二次兜底：从总结文本里正则提取（模型常写成 "结论：confirmed"）
  if (isVerify && !verdict) {
    const m = summary.match(/\b(confirmed|false_positive|needs_human)\b/);
    if (m) verdict = m[1];
  }
  // verdict 合法值收敛：模型可能输出 "confirmed（确认可利用）" 之类
  if (verdict) {
    const m = verdict.match(/\b(confirmed|false_positive|needs_human)\b/);
    verdict = m?.[1];
  }
  if (isVerify && !verdict) {
    console.warn(`[real-agent] verify 缺 verdict，done.json 原文: ${doneRaw.slice(0, 200)}`);
  }

  await emit("done", {
    summary: `${summary}（结构化 finding: ${findingCount} 条）`,
    ...(isVerify && verdict ? { verdict } : {}),
  });
}
