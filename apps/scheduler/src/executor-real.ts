import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRealAgent } from "@dfh/runtime-sandbox";
import { FindingPayload } from "@dfh/shared-types";
import { config } from "./config.js";
import { ingestEvent, rulesForProject, type AgentProfileSnapshot } from "./core.js";
import { sql } from "./db.js";
import { buildGraphSnapshot, parseFactOutput, parseHubDecision } from "./graph.js";
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

/** hub 决策 prompt（Cairn reason.md 改造，§8.3）：读整张图 → complete 或派发 intents */
const HUB_PROMPT = (graphYaml: string, maxIntents: number) => `你是安全审计的调度中枢（hub）。画布当前状态（YAML）：

${graphYaml}

可用角色：explore（探索：通读 /workspace/src 代码，围绕意图收集新事实）

要求：
1. 判断 goal 是否已达成：
   - 已达成 → 写 /workspace/hub.json：{"complete":{"from":["<被引用事实的id>",...],"description":"总结论（中文，200 字内）"}}
   - 未达成 → 写 /workspace/hub.json：{"intents":[{"from":["<作为出发点的事实id>",...],"role":"explore","description":"要做的事（具体、可执行）"}]}
2. 最多 ${maxIntents} 个意图；意图必须高价值、互不重叠、可并行；from 只能引用上面 facts 里存在的 id
3. 不要提出与 open_intents / concluded_intents 语义重复的意图
4. 若 open_intents 为空且目标未达成，必须提出新意图
5. hub.json 必须是纯 JSON，不要用 markdown 代码围栏包裹`;

/** 角色（explore）prompt（Cairn explore.md 改造）：围绕意图探索 → 增量事实 */
const EXPLORE_PROMPT = (graphYaml: string, intentDescription: string) => `你是探索 agent。代码在 /workspace/src。

当前意图：${intentDescription}

画布已有内容（YAML，不要重复其中的事实）：
${graphYaml}

要求：
1. 围绕意图阅读代码，收集与意图直接相关的新事实（疑似漏洞线索、关键数据流、危险调用点等）
2. 写 /workspace/fact.json：{"title":"事实标题（20 字内）","description":"事实描述（中文，300 字内，含具体文件:行号）"}
   - 只写增量事实，不要复述画布已有内容；事实要具体、可被后续验证
   - 必须是纯 JSON，不要用 markdown 代码围栏包裹
3. 完成后写 /workspace/done.json：{"summary":"探索过程总结（中文，100 字内）"}
4. 不要修改源代码`;

export async function executeReal(jobId: string, type: string): Promise<void> {
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`job ${jobId} 不存在`);

  const emit = (t: string, payload: unknown) =>
    ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: t as never, payload });

  const isVerify = type === "verify_finding";
  const isHub = type === "hub_reason";
  const isRole = !isVerify && !isHub && type !== "audit_module"; // explore 等角色 job
  const payload = job.payload_json as Record<string, unknown>;
  const canvasId = (job.canvas_id as string) ?? null;

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

  // prompt 按 job 类型分派；hub/角色 job 需要整张图（YAML）作上下文
  const rules = await rulesForProject(sql, job.project_id as string);
  const graph = canvasId && (isHub || isRole) ? await buildGraphSnapshot(canvasId) : null;
  const intentDesc =
    ((payload.intent as { description?: string } | undefined)?.description as string) ?? "";
  let basePrompt: string;
  if (isHub) {
    if (!graph) throw new Error("hub_reason job 缺 canvas_id，无法读图");
    basePrompt = HUB_PROMPT(graph.yaml, rules.maxIntentsPerDecision);
  } else if (isRole) {
    if (!graph) throw new Error(`${type} job 缺 canvas_id，无法读图`);
    basePrompt = EXPLORE_PROMPT(graph.yaml, intentDesc || "自由探索代码，收集安全相关事实");
  } else if (isVerify) {
    basePrompt = VERIFY_PROMPT((payload.finding ?? {}) as { title: string; location?: string; summary?: string });
  } else {
    basePrompt = AUDIT_PROMPT(payload.module_path as string | undefined);
  }
  const prompt = snapshot?.prompt_suffix ? `${basePrompt}\n\n${snapshot.prompt_suffix}` : basePrompt;

  // 结果文件契约按类型：audit=findings+done；hub=hub.json；角色=fact.json+done
  const resultFiles = isHub
    ? ["/workspace/hub.json", "/workspace/done.json"]
    : isRole
      ? ["/workspace/fact.json", "/workspace/done.json"]
      : isVerify
        ? ["/workspace/done.json"]
        : ["/workspace/findings.jsonl", "/workspace/done.json"];

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
      // 审计任务注入演示仓库；验证/探索任务复用同一演示仓库；hub 只读图不需要代码
      seedFiles: isHub ? {} : seedFilesFromDir(DEMO_REPO),
      resultFiles,
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

  // findings 落库（schema 校验 + 上限 20 条/§4.3 护栏语义）——仅审计 job
  let findingCount = 0;
  if (!isVerify && !isHub && !isRole) {
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
  }

  // hub 决策落地（§8.3）：hub.json → complete / intents → 派生角色 job
  let hubNote = "";
  if (isHub) {
    const raw = result.files["/workspace/hub.json"] ?? "";
    const decision = parseHubDecision(raw);
    if (!decision) {
      console.warn(`[real-agent] hub.json 解析失败，原文: ${raw.slice(0, 200)}`);
      hubNote = "（hub.json 解析失败）";
    } else if (decision.complete) {
      await emit("hub_decision", { complete: decision.complete });
      hubNote = `（结论：${decision.complete.description.slice(0, 80)}）`;
    } else {
      const intents = (decision.intents ?? []).slice(0, rules.maxIntentsPerDecision);
      if (intents.length > 0) {
        await emit("hub_decision", { intents });
        hubNote = `（派发 ${intents.length} 个意图）`;
      } else {
        hubNote = "（无新意图）";
      }
    }
  }

  // 角色 job 事实落地：fact.json → fact 节点（agent 只负责把发现写入画布）
  let factNote = "";
  if (isRole) {
    const raw = result.files["/workspace/fact.json"] ?? "";
    const fact = parseFactOutput(raw);
    if (!fact) {
      console.warn(`[real-agent] fact.json 解析失败，原文: ${raw.slice(0, 200)}`);
      factNote = "（fact.json 解析失败）";
    } else {
      await emit("fact", {
        intent_node_id: (payload.intent_node_id as string) ?? null,
        title: fact.title,
        description: fact.description,
      });
      factNote = `（事实：${fact.title.slice(0, 60)}）`;
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
    summary: `${summary}${hubNote}${factNote}${findingCount > 0 ? `（结构化 finding: ${findingCount} 条）` : ""}`,
    ...(isVerify && verdict ? { verdict } : {}),
  });
}
