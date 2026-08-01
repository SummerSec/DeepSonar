import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runRealAgent } from "@dfh/runtime-sandbox";
import { FindingPayload } from "@dfh/shared-types";
import { config } from "./config.js";
import { ingestEvent, rolesForProject, rulesForProject, type AgentProfileSnapshot } from "./core.js";
import { sql } from "./db.js";
import { buildGraphSnapshot, parseFactOutput, parseHubDecision } from "./graph.js";
import { ingestCodeSource, type RepoEvidence, type RepoSpec } from "./repo-ingest.js";
import { decryptSecret, PROVIDER_ENV_MAP } from "./credentials.js";
import { publishStream } from "./stream-bus.js";

/**
 * 真实 Agent 执行器（ARCHITECTURE §8）
 * 契约：agent 在沙箱内审计 /workspace/src，
 *   findings → /workspace/findings.jsonl（每行一个 SARIF 子集 JSON）
 *   总结    → /workspace/done.json（{"summary": "...", "verdict": "..."?}）
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO_REPO = path.join(REPO_ROOT, "agent-harness", "demo-repo");

const execFileP = promisify(execFile);

/** 本地镜像 digest（§10.3 证据链；镜像不存在/无 docker 时返回 null，不阻断执行） */
async function imageDigestOf(image: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("docker", ["image", "inspect", "--format", "{{.Id}}", image], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

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

function repoLimits() {
  return {
    maxFiles: config.repo.maxFiles,
    maxTotalBytes: config.repo.maxTotalMb * 1024 * 1024,
    maxFileBytes: config.repo.maxFileKb * 1024,
    cloneTimeoutSec: config.repo.cloneTimeoutSec,
    allowedGitHosts: config.repo.allowedGitHosts.split(",").map((s) => s.trim()).filter(Boolean),
    localRoots: config.repo.localRoots.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function extractRepoSpec(o: Record<string, unknown> | null | undefined): RepoSpec | null {
  if (!o) return null;
  const repoUrl = typeof o.repo_url === "string" && o.repo_url.trim() ? o.repo_url.trim() : undefined;
  const repoPath = typeof o.repo_path === "string" && o.repo_path.trim() ? o.repo_path.trim() : undefined;
  const ref = typeof o.ref === "string" && o.ref.trim() ? o.ref.trim() : undefined;
  if (!repoUrl && !repoPath) return null;
  return { repoUrl, repoPath, ref };
}

/**
 * 解析本 job 的代码来源（RUN-01）：job.payload → 画布 target_json → demo-repo 兜底。
 * 摄入证据（§10.1 任务记录）写回 job.payload_json.repo_evidence 并发 progress 事件。
 */
async function resolveSeedFiles(
  job: Record<string, unknown>,
  emit: (t: string, p: unknown) => Promise<unknown>,
): Promise<Record<string, string>> {
  const payload = (job.payload_json ?? {}) as Record<string, unknown>;
  // 已摄入过（重试链上的后续 job 复用同画布时每个 job 各自摄入，保证 commit 固定到当次执行）
  let spec = extractRepoSpec(payload);
  if (!spec && job.canvas_id) {
    const [canvas] = await sql`SELECT target_json FROM canvases WHERE id = ${job.canvas_id as string}`;
    spec = extractRepoSpec((canvas?.target_json ?? null) as Record<string, unknown> | null);
  }

  let files: Record<string, string>;
  let evidence: RepoEvidence;
  if (!spec) {
    // 未指定代码源：回退演示仓库（仅联调/演示；生产任务应在任务里带 repo_path/repo_url）
    console.warn(`[real-agent] job ${job.id} 未指定代码源，回退 demo-repo`);
    files = seedFilesFromDir(DEMO_REPO);
    const total = Object.values(files).reduce((s, c) => s + Buffer.byteLength(c, "utf8"), 0);
    evidence = {
      source: "demo",
      file_count: Object.keys(files).length,
      total_bytes: total,
      skipped_files: 0,
      manifest_sha256: "",
      ingested_at: new Date().toISOString(),
    };
  } else {
    const result = await ingestCodeSource(spec, repoLimits());
    files = result.files;
    evidence = result.evidence;
  }

  await sql`
    UPDATE jobs SET payload_json = payload_json || ${sql.json({ repo_evidence: evidence } as never)}
    WHERE id = ${job.id as string}`;
  await emit("progress", {
    message:
      `代码摄入完成：${evidence.file_count} 个文件 / ${(evidence.total_bytes / 1024).toFixed(0)}KB` +
      (evidence.resolved_commit_sha ? ` @ ${evidence.resolved_commit_sha.slice(0, 12)}` : "") +
      (evidence.skipped_files > 0 ? `（跳过 ${evidence.skipped_files}）` : "") +
      (evidence.source === "demo" ? "（演示仓库）" : ""),
  });
  return files;
}

/** 通用占位符渲染：{{key}} 全部替换 */
function render(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

/**
 * prompt 模板一律从 agent_roles 表读（§8.3 所有配置落库，用户可在设置页改）；
 * 库中缺行时退回代码兜底常量。
 */
async function templateFor(name: string, fallback: string): Promise<string> {
  const [row] = await sql`SELECT prompt_template FROM agent_roles WHERE name = ${name}`;
  return (row?.prompt_template as string) ?? fallback;
}

// ---------- 兜底模板（与 0007 迁移种子一致；库里有行时不会用到） ----------

const FALLBACK_AUDIT = `你是一个白盒安全审计专家。代码在 /workspace/src（重点审计 {{module_path}}）。

要求：
1. 通读代码，找出真实可利用的安全漏洞（SQL 注入、XSS、路径穿越、任意文件上传、硬编码密钥、危险函数等）
2. 每个漏洞写一行 JSON 到 /workspace/findings.jsonl（JSONL 格式，每行一个对象）：
   {"title":"...","severity":"low|medium|high|critical","location":"相对路径:行号","summary":"成因与利用方式（中文，100 字内）","rule_id":"规则标识","suggest_verify":true}
3. 只报告有把握的洞，宁缺毋滥；location 必须精确到行
4. 完成后写 /workspace/done.json：{"summary":"审计总结（中文，200 字内，含漏洞数量与最高级别）"}
   必须是纯 JSON 文件，不要用 markdown 代码围栏包裹
5. 不要修改源代码，不要输出 findings.jsonl 以外的漏洞报告`;

const FALLBACK_VERIFY = `你是一个漏洞验证专家。代码在 /workspace/src。请验证以下审计发现是否真实成立：

标题：{{finding_title}}
位置：{{finding_location}}
描述：{{finding_summary}}

要求：
1. 阅读相关代码，静态分析该漏洞是否真实存在、是否可利用
2. 写 /workspace/done.json：{"summary":"验证过程与结论（中文，150 字内）","verdict":"confirmed|false_positive|needs_human"}
   - confirmed=确认真实可利用；false_positive=误报；needs_human=无法确定需人工
   - verdict 字段只能是这三个英文词之一，不要带任何括号注释；文件必须是纯 JSON，不要用 markdown 代码围栏包裹
3. 不要修改源代码`;

const FALLBACK_HUB = `你是安全审计的调度中枢（hub）。画布当前状态（YAML）：

{{graph}}

可用角色（intents 的 role 字段只能从这里选）：
{{roles}}

要求：
1. 判断 goal 是否已达成：
   - 已达成 → 写 /workspace/hub.json：{"complete":{"from":["<被引用事实的id>",...],"description":"总结论（中文，200 字内）"}}
   - 未达成 → 写 /workspace/hub.json：{"intents":[{"from":["<作为出发点的事实id>",...],"role":"<角色名>","description":"要做的事（具体、可执行）"}]}
2. 最多 {{max_intents}} 个意图；意图必须高价值、互不重叠、可并行；from 只能引用上面 facts 里存在的 id
3. 不要提出与 open_intents / concluded_intents 语义重复的意图
4. 若 open_intents 为空且目标未达成，必须提出新意图
5. hub.json 必须是纯 JSON，不要用 markdown 代码围栏包裹`;

/** 角色表缺行时的兜底模板（与 0006 迁移里 explore 种子一致） */
const FALLBACK_ROLE = `你是{{role}} agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML，不要重复其中的事实）：
{{graph}}

要求：
1. 围绕意图阅读代码，收集与意图直接相关的新事实
2. 写 /workspace/fact.json：{"title":"事实标题（20 字内）","description":"事实描述（中文，300 字内，含具体文件:行号）"}
   - 只写增量事实；必须是纯 JSON，不要用 markdown 代码围栏包裹
3. 完成后写 /workspace/done.json：{"summary":"总结（中文，100 字内）"}
4. 不要修改源代码`;

export async function executeReal(jobId: string, type: string): Promise<void> {
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`job ${jobId} 不存在`);

  const emit = (t: string, payload: unknown) =>
    ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: t as never, payload });

  const isVerify = type === "verify_finding";
  const isHub = type === "hub_reason";
  const isAudit = type === "audit_module" || type === "audit";
  const isRole = !isVerify && !isHub && !isAudit; // explore 等产出 fact 的角色 job
  const payload = job.payload_json as Record<string, unknown>;
  const canvasId = (job.canvas_id as string) ?? null;

  // Agent 配置：job 冻结的 profile 快照优先，无快照退回 env 全局配置（§8.1 下一 job 生效）
  const snapshot = (job.agent_snapshot_json as AgentProfileSnapshot | null) ?? null;
  const cliName = snapshot?.agent_cli ?? config.runtime.agentProvider;
  const provider = (cliName === "opencode" ? "open-code" : cliName) as "claude-code" | "open-code" | "codex";
  const model = snapshot?.model ?? config.runtime.agentModel ?? undefined;
  // env 注入两条路径（§6.2）：
  // 1. 目标路径——profile 绑定 Credential：运行时解密，按固定 Provider→env 映射注入（用户不能自由写变量名）
  // 2. 过渡路径——profile env_keys（变量名引用调度器 process.env，有白名单门禁；逐步废弃）
  const env: Record<string, string> = { ...config.runtime.agentEnv };
  if (snapshot?.credential_id) {
    const [cred] = await sql`SELECT * FROM credentials WHERE id = ${snapshot.credential_id}`;
    if (!cred || (cred.status as string) !== "active") {
      throw new Error(`profile 绑定的凭据不可用（${cred ? "status=" + String(cred.status) : "不存在"}）`);
    }
    const mapping = PROVIDER_ENV_MAP[cred.provider as string];
    if (!mapping) throw new Error(`未知 provider: ${String(cred.provider)}`);
    const secret = decryptSecret(cred as never);
    for (const k of mapping.secretKeys) env[k] = secret;
    const meta = (cred.public_metadata_json ?? {}) as { base_url?: string };
    const baseUrl = meta.base_url ?? mapping.defaultBaseUrl;
    if (mapping.baseUrlKey && baseUrl) env[mapping.baseUrlKey] = baseUrl;
    void sql`UPDATE credentials SET last_used_at = now() WHERE id = ${cred.id as string}`.catch(() => {});
  } else {
    for (const key of snapshot?.env_keys ?? []) {
      if (!config.runtime.isEnvKeyAllowed(key)) {
        console.warn(`[real-agent] env_key 不在白名单，拒绝注入: ${key}`);
        continue;
      }
      const v = process.env[key];
      if (v) env[key] = v;
    }
  }

  // prompt 按 job 类型分派；hub/角色 job 需要整张图（YAML）作上下文
  const rules = await rulesForProject(sql, job.project_id as string);
  const graph = canvasId && (isHub || isRole || type === "audit") ? await buildGraphSnapshot(canvasId) : null;
  const intentDesc =
    ((payload.intent as { description?: string } | undefined)?.description as string) ?? "";
  let basePrompt: string;
  // §10.3 证据链：记录实际使用的模板名 + 最终 prompt 哈希
  let templateName: string;
  if (isHub) {
    templateName = "hub_reason";
    if (!graph) throw new Error("hub_reason job 缺 canvas_id，无法读图");
    const roles = await rolesForProject(sql, job.project_id as string);
    if (roles.length === 0) throw new Error("项目未启用任何角色，hub 无可下发对象");
    basePrompt = render(await templateFor("hub_reason", FALLBACK_HUB), {
      graph: graph.yaml,
      roles: roles.map((r) => `- ${r.name}（${r.title}）：${r.description}`).join("\n"),
      max_intents: String(rules.maxIntentsPerDecision),
    });
    const trigger = payload.trigger as { kind?: string; finding_id?: string } | undefined;
    if (trigger?.kind === "confirmed_finding") {
      basePrompt = `${basePrompt}\n\n本轮由已确认风险触发。请对该 Finding 做验收，并自行决定后续工作；优先考虑运行/模型环境搭建、最小 PoC、动态复现、影响确认等，可派发 test、verify、analyze、code 等已启用角色。不要仅因静态验证已 confirmed 就直接宣布目标完成。`;
    } else if (trigger?.kind === "risk_acceptance_followup") {
      basePrompt = `${basePrompt}\n\n这是已确认风险的回收验收轮次。请审查环境搭建、PoC、动态复现或影响分析 Agent 新产出的事实：证据足够则给出 complete 结论；证据不足则只派发必要的下一步，不要重复已有工作。`;
    } else if (["user_task", "plane_issue", "external_event"].includes(trigger?.kind ?? "")) {
      basePrompt = `${basePrompt}\n\n这是任务的首次决策轮次。你是入口决策者，不要在尚未派发任何意图时直接 complete。请根据目标选择 audit、explore、analyze、verify、test、code 等最合适的已启用角色；安全审计类目标应优先派发 audit。初始意图的 from 可以引用 graph 中的 root_id。`;
      if (trigger?.kind === "external_event") {
        basePrompt = `${basePrompt}\n这是外部事件触发的任务；先判断事件表达的风险和所需动作，再决定派发范围，不要把事件字段机械当成人工指令。`;
      }
    }
  } else if (isRole) {
    templateName = type;
    if (!graph) throw new Error(`${type} job 缺 canvas_id，无法读图`);
    basePrompt = render(await templateFor(type, FALLBACK_ROLE), {
      graph: graph.yaml,
      intent: intentDesc || "自由探索代码，收集安全相关事实",
      role: type,
    });
  } else if (isVerify) {
    templateName = "verify_finding";
    const finding = (payload.finding ?? {}) as { title?: string; location?: string; summary?: string };
    basePrompt = render(await templateFor("verify_finding", FALLBACK_VERIFY), {
      finding_title: finding.title ?? "未知",
      finding_location: finding.location ?? "未知",
      finding_summary: finding.summary ?? "无",
    });
  } else {
    templateName = type === "audit" ? "audit" : "audit_module";
    basePrompt = render(await templateFor(type === "audit" ? "audit" : "audit_module", FALLBACK_AUDIT), {
      module_path: (payload.module_path as string) ?? "全部模块",
      intent: intentDesc || String(payload.content ?? payload.goal ?? "执行安全审计"),
      graph: graph?.yaml ?? "无",
    });
    const taskTitle = String(payload.title ?? "").trim();
    const taskContent = String(payload.content ?? payload.goal ?? "").trim();
    if (taskTitle || taskContent) {
      basePrompt = `${basePrompt}\n\n用户任务：\n标题：${taskTitle || "未命名任务"}\n内容：${taskContent || taskTitle}\n\n请把用户内容作为目标，自行决定审计范围、顺序与方法；不要要求用户补充内部调度参数。`;
    }
  }
  const prompt = snapshot?.prompt_suffix ? `${basePrompt}\n\n${snapshot.prompt_suffix}` : basePrompt;

  // ---------- 证据链（§10.3）：镜像 digest / provider / 模型 / prompt 版本随 job 冻结 ----------
  const runtimeEvidence: Record<string, unknown> = {
    image: config.runtime.imageAudit,
    image_digest: await imageDigestOf(config.runtime.imageAudit),
    agent_provider: provider,
    model: model ?? null,
    credential_id: snapshot?.credential_id ?? null,
    credential_provider: snapshot?.credential_provider ?? null,
    prompt_template: templateName,
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    skill_revisions: snapshot?.skill_revisions ?? [],
    recorded_at: new Date().toISOString(),
  };
  await sql`
    UPDATE jobs SET payload_json = payload_json || ${sql.json({ runtime_evidence: runtimeEvidence } as never)}
    WHERE id = ${job.id as string}`;

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

  // 代码摄入（RUN-01/§10）：hub 只读图不需要代码；其余按任务 repo_path/repo_url 摄入
  const seedFiles = isHub ? {} : await resolveSeedFiles(job, emit);

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
      // 审计/验证/角色任务注入摄入的真实代码（未指定时回退演示仓库）；hub 只读图不需要代码
      seedFiles,
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
