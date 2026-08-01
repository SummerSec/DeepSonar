#!/usr/bin/env node
/**
 * DeepFlowHunter Management API CLI（Management Skill 的脚本入口）
 *
 * 环境变量：
 *   DFH_BASE_URL   调度器地址（默认 http://localhost:3100）
 *   DFH_API_TOKEN  Platform API Token（dfh_<env>_<prefix>_<secret>）；auth 关闭时可省略
 *
 * 用法：node dfh-api.mjs <资源> <动作> [位置参数] [--flag value...]
 * 输出：stdout 单行/多行 JSON（结构化，便于其他 Agent 消费）；错误走 stderr + 非零退出码。
 */
const BASE = (process.env.DFH_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const TOKEN = process.env.DFH_API_TOKEN ?? "";

function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

async function call(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error ?? data?.message ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function emit(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function need(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`缺少参数: ${name}`);
  }
  return value;
}

/** 命令表：resource.action → (pos, flags) => API 调用 */
const COMMANDS = {
  health: () => call("GET", "/health"),

  "projects.list": () => call("GET", "/projects"),
  "projects.get": (pos) => call("GET", `/projects/${need(pos[0], "projectId")}`),
  "projects.create": (_pos, f) =>
    call("POST", "/projects", { name: need(f.name, "--name"), ...(f.description ? { description: f.description } : {}) }),
  "projects.update": (pos, f) =>
    call("PATCH", `/projects/${need(pos[0], "projectId")}`, JSON.parse(need(f.data, '--data \'{"k":"v"}\''))),
  "projects.archive": (pos) => call("POST", `/projects/${need(pos[0], "projectId")}/archive`),

  "tasks.create": (pos, f) => {
    // CreateTaskBody：title + content（必填）；repo_url/repo_path/ref 进画布 target_json。
    // module_path 暂无独立字段，拼入 content 作为审计目标提示。
    const title = need(f.title, "--title");
    const content =
      (f.content ?? title) + (f["module-path"] ? `\n\n审计目标模块: ${f["module-path"]}` : "");
    return call("POST", `/projects/${need(pos[0], "projectId")}/tasks`, {
      title,
      content,
      ...(f["repo-url"] ? { repo_url: f["repo-url"] } : {}),
      ...(f["repo-path"] ? { repo_path: f["repo-path"] } : {}),
      ...(f.ref ? { ref: f.ref } : {}),
    });
  },
  "tasks.retry": (pos) => call("POST", `/tasks/${need(pos[0], "canvasId")}/retry`),

  "events.push": (pos, f) =>
    call("POST", `/projects/${need(pos[0], "projectId")}/events`, {
      source: need(f.source, "--source"),
      event_id: need(f["event-id"], "--event-id"),
      event_type: f["event-type"] ?? "generic",
      ...(f.title ? { title: f.title } : {}),
      ...(f.content ? { content: f.content } : {}),
      ...(f.data ? { data: JSON.parse(f.data) } : {}),
    }),

  "jobs.list": (_pos, f) => call("GET", `/jobs${f.project ? `?project_id=${f.project}` : ""}`),
  "jobs.get": (pos) => call("GET", `/jobs/${need(pos[0], "jobId")}`),
  "jobs.priority": (pos, f) =>
    call("PATCH", `/jobs/${need(pos[0], "jobId")}/priority`, { priority: Number(need(f.priority, "--priority")) }),
  "jobs.cancel": (pos) => call("POST", `/jobs/${need(pos[0], "jobId")}/cancel`),
  "jobs.resume": (pos) => call("POST", `/jobs/${need(pos[0], "jobId")}/resume`),

  "findings.list": (_pos, f) => call("GET", `/findings${f.project ? `?project_id=${f.project}` : ""}`),

  "canvases.list": (pos) => call("GET", `/projects/${need(pos[0], "projectId")}/canvases`),
  "canvases.get": (pos) => call("GET", `/canvases/${need(pos[0], "canvasId")}`),

  "plane.bind": (pos, f) =>
    call("PUT", `/projects/${need(pos[0], "projectId")}/integrations/plane`, {
      plane_project_id: need(f["project-id"], "--project-id"),
    }),
  "plane.unbind": (pos) => call("DELETE", `/projects/${need(pos[0], "projectId")}/integrations/plane`),
  "plane.sync": (pos) => call("POST", `/projects/${need(pos[0], "projectId")}/integrations/plane/sync`),

  "settings.get": () => call("GET", "/global-settings"),
};

async function main() {
  const [resource, action, ...rest] = process.argv.slice(2);
  if (!resource) {
    process.stderr.write(
      `用法: dfh-api.mjs <资源> <动作> [args] [--flag value]\n可用: ${Object.keys(COMMANDS).join(", ")}\n`,
    );
    process.exit(64);
  }
  const key = action ? `${resource}.${action}` : resource;
  const fn = COMMANDS[key];
  if (!fn) {
    process.stderr.write(`未知命令: ${key}\n可用: ${Object.keys(COMMANDS).join(", ")}\n`);
    process.exit(64);
  }
  const { pos, flags } = parseFlags(rest);
  try {
    emit(await fn(pos, flags));
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ ok: false, status: e.status ?? null, error: e.message, details: e.body ?? null }) + "\n",
    );
    process.exit(e.status === 401 || e.status === 403 ? 3 : 1);
  }
}

main();
