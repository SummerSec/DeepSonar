import {
  CANONICAL_UUID_PATTERN,
  ControlToolInputSchemasJson,
  HUB_REFERENCE_LIMITS,
  WORKSPACE_PAYLOAD_FILE_MAX_BYTES,
  WORKSPACE_PAYLOAD_FILE_PATTERN,
} from "@deepsonar/shared-types";
import {
  CONTROL_INPUT_ERROR_CODES,
  INVALID_PAYLOAD_MESSAGE,
  INVALID_NODE_REF_MESSAGE,
  INVALID_REFERENCE_BUDGET_MESSAGE,
} from "./control-input.js";
import {
  SHARED_ASSETS_MOUNT_CATALOG,
  SHARED_ASSETS_READONLY_ROOT,
  SHARED_ASSETS_WORKSPACE_CATALOG,
} from "./domains/shared-assets/catalog.js";

/**
 * 每 Job 注入的本地 MCP。它不连接 Scheduler，也不使用网络：只读查询返回调度器在启动
 * 本 Job 时动态下发的数据；语义提案由宿主先暂存 Claude stream-json 的 tool_use，
 * 仅在对应的合法非错误 tool_result（is_error 省略或为 false）后释放。
 */
export const CONTROL_MCP_NAME = "deepsonar-control";
export const CONTROL_SEMANTIC_EVENT_TYPES = {
  emit_progress: "progress",
  emit_fact: "fact",
  emit_finding: "finding",
  submit_hub_decision: "hub_decision",
  mark_job_done: "done",
  request_human: "human",
  publish_shared_asset: "shared_asset_publish",
} as const;

export const CONTROL_MCP_SERVER = String.raw`import readline from "node:readline";
import { lstatSync, readFileSync } from "node:fs";

const allowed = new Set(JSON.parse(process.env.DEEPSONAR_CONTROL_TOOL_NAMES || "[]"));
const availableRoles = JSON.parse(process.env.DEEPSONAR_AVAILABLE_ROLES_JSON || "[]");
const CANONICAL_UUID_PATTERN = ${JSON.stringify(CANONICAL_UUID_PATTERN)};
const INVALID_NODE_REF_CODE = ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidNodeRef)};
const INVALID_NODE_REF_MESSAGE = ${JSON.stringify(INVALID_NODE_REF_MESSAGE)};
const INVALID_REFERENCE_BUDGET_CODE = ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidReferenceBudget)};
const INVALID_REFERENCE_BUDGET_MESSAGE = ${JSON.stringify(INVALID_REFERENCE_BUDGET_MESSAGE)};
const INVALID_PAYLOAD_CODE = ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)};
const INVALID_PAYLOAD_MESSAGE = ${JSON.stringify(INVALID_PAYLOAD_MESSAGE)};
const UNKNOWN_FIELD_CODE = ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.unknownField)};
const UNKNOWN_TOOL_CODE = ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.unknownTool)};
const TOOL_NOT_ALLOWED_CODE = ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.toolNotAllowed)};
const TOOL_ERROR_CODES = {
  emit_progress: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidProgress)},
  emit_fact: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)},
  emit_finding: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)},
  submit_hub_decision: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)},
  mark_job_done: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidDone)},
  request_human: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidHuman)},
  list_available_roles: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)},
  list_shared_assets: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)},
  publish_shared_asset: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidPayload)},
};
const TOOL_INPUT_SCHEMAS = ${JSON.stringify(ControlToolInputSchemasJson)};
const MAX_REFERENCES_PER_FROM = ${HUB_REFERENCE_LIMITS.perFrom};
const MAX_UNIQUE_REFERENCES = ${HUB_REFERENCE_LIMITS.totalUnique};
const MAX_PAYLOAD_FILE_BYTES = ${WORKSPACE_PAYLOAD_FILE_MAX_BYTES};
const PAYLOAD_FILE_PATTERN = new RegExp(${JSON.stringify(WORKSPACE_PAYLOAD_FILE_PATTERN.source)});
const NODE_REF_RE = new RegExp(CANONICAL_UUID_PATTERN, "i");
const hasOwn = (object, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const availableRoleNames = availableRoles
  .map((role) => (role && typeof role === "object" ? role.name : null))
  .filter((name) => typeof name === "string" && name.length > 0);
// Constrain intents[].role to this Job's role catalog so Claude cannot invent
// abbreviations (e.g. "a") that later fail Scheduler invalid_role.
(() => {
  const hubSchema = TOOL_INPUT_SCHEMAS.submit_hub_decision;
  if (!hubSchema || typeof hubSchema !== "object" || availableRoleNames.length === 0) return;
  const properties = hubSchema.properties && typeof hubSchema.properties === "object" ? hubSchema.properties : null;
  const intents = properties && properties.intents && typeof properties.intents === "object" ? properties.intents : null;
  const items = intents && intents.items && typeof intents.items === "object" ? intents.items : null;
  const itemProps = items && items.properties && typeof items.properties === "object" ? items.properties : null;
  if (!itemProps || !itemProps.role || typeof itemProps.role !== "object") return;
  itemProps.role = { ...itemProps.role, type: "string", enum: availableRoleNames };
})();

const descriptions = {
  list_available_roles: "返回当前 Hub Job 可派发的数据库角色。只使用返回的 name，不得猜测或使用固定角色清单。",
  emit_progress: "增量上报当前动作或阶段进展。可在执行中多次调用。",
  emit_fact: "把一个新的、可验证的增量事实实时写入任务画布。直接提交时 title 至少 2 个非空白字符、description 至少 16 个非空白字符；长内容或收到 isError/截断后，先 Write 到 /workspace 下 JSON，再只传 payload_file，禁止用故意缩短的内容重试。Hub 回弹补证 Job 可附带 verification 结构化证据。可多次调用。",
  emit_finding: "实时提交一条有证据的通用 Finding。直接提交时 title 至少 8 个非空白字符、summary 至少 32 个非空白字符；长内容或收到 isError/截断后，先 Write 到 /workspace 下 JSON，再只传 payload_file，禁止用故意缩短的内容重试。profile 与可选评分须符合任务冻结协议，调度器负责校验、重算、去重和验证。可多次调用。",
  submit_hub_decision: "提交本轮 Hub 的 complete、intents 或 payload_file 决策，三者必须且只能提供一个。大体积多意图时优先 Write 到 /workspace 下 JSON 文件再传 payload_file（相对路径，如 hub_decision_payload.json），避免 tool 参数截断。from 必须填写当前 YAML root_id/fact/finding 节点的 UUID 值。role 必须原样使用 list_available_roles 返回的 name。每个 Job 成功提交后只能一次；仅上一次 isError 时可重试。不要与 request_human 混用。",
  mark_job_done: "提交本 Job 的最终摘要，至少 8 个非空白字符；verify 系统角色还必须提交 verdict（confirmed|rework|needs_human；兼容 false_positive→rework）。每个 Job 最后调用一次。",
  request_human: "提交至少 8 个非空白字符的人工介入理由；只有缺少必要授权、凭据或高风险操作必须人工确认时调用。",
  list_shared_assets: "分页列出本 Job 创建时冻结的只读共享资产目录。没有单独的下载工具：用返回的 mount_path/read_path 以普通文件工具直接读取（Scheduler 已从本地或 S3 兼容存储预挂载）。可按 scope 或逻辑 key 前缀过滤。",
  publish_shared_asset: "提议把 /workspace 下普通工作文件发布为项目或当前 Finding 的不可变共享资产版本。Scheduler 经 BlobStore 落库（本地或任意 S3 兼容存储）；禁止发布平台运行目录或 CLI 用户/配置目录中的内容。",
};
const descriptionCautions = {
  list_available_roles: "Hub 派发前调用；必须原样复制返回的 name，不得猜测、缩写或使用已禁用及 system 角色。",
  emit_progress: "只用于增量进度，可按需多次调用；不得代替最终结论或 Finding，仅在返回 isError 后重试。",
  emit_fact: "每个新增可验证事实提交一次，不得重复提交或故意缩短内容；遇到 isError 或截断时，写入完整 JSON 后用 payload_file 重试。",
  emit_finding: "只提交有证据支撑的 Finding；suggest_verify 只是建议，不能当作派发决定；遇到 isError 或截断时用 payload_file 提交完整内容。",
  submit_hub_decision: "仅 Hub 使用：读完画布和可用角色后、mark_job_done 前调用，complete、intents、payload_file 必须三选一；仅在 isError 或校验失败后重试，成功后不得再次调用。",
  mark_job_done: "仅主协调 Agent 在所有子代理结束后调用，子代理不得调用；结束时只调用一次，首次合法 summary 为权威结果，迟到的重复调用会被忽略且不会覆盖，成功后不得重试。",
  request_human: "仅在必要授权、凭据或高风险审批阻塞时调用一次；调用后停止，不得再调用 mark_job_done，仅在返回 isError 后重试。",
  list_shared_assets: "用于发现本 Job 冻结的只读资产，再按返回路径读取；不得修改共享挂载，也不得通过 HTTP、curl 或 S3 另行获取，可安全重复查询。",
  publish_shared_asset: "只发布普通 /workspace 中可复用的工作文件；不得发布平台运行目录或 CLI 用户/配置目录中的内容，仅在返回 isError 后重试。",
};
const definitions = Object.fromEntries(
  Object.keys(TOOL_INPUT_SCHEMAS).map((name) => [name, {
    description: hasOwn(descriptions, name) ? descriptions[name] : "DeepSonar 控制工具。",
    inputSchema: TOOL_INPUT_SCHEMAS[name],
  }]),
);

for (const [name, caution] of Object.entries(descriptionCautions)) {
  if (definitions[name]) definitions[name].description += " " + caution;
}

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function schemaError(path, message, code = INVALID_PAYLOAD_CODE) {
  return { code, text: "[" + code + "] " + INVALID_PAYLOAD_MESSAGE + " 字段 " + path + "：" + message };
}

function validateSchema(value, schema, path) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.const !== undefined && value !== schema.const) return schemaError(path, "必须等于指定常量");
  if (Array.isArray(schema.anyOf)) {
    const failures = schema.anyOf.map((candidate) => validateSchema(value, candidate, path)).filter(Boolean);
    return failures.length === schema.anyOf.length ? failures[0] : null;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => !validateSchema(value, candidate, path));
    return matches.length === 1 ? null : schemaError(path, "必须且只能匹配一个输入形状");
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      const failure = validateSchema(value, candidate, path);
      if (failure) return failure;
    }
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return schemaError(path, "必须是 JSON 对象");
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) return schemaError(path, "字段数量不足");
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) return schemaError(path, "字段数量超限");
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return schemaError(path + "." + key, "缺少必填字段");
    }
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !Object.prototype.hasOwnProperty.call(properties, key)) {
        return schemaError(path + "." + key, "不允许未知字段", UNKNOWN_FIELD_CODE);
      }
      const propertySchema = properties[key];
      if (propertySchema) {
        const failure = validateSchema(value[key], propertySchema, path + "." + key);
        if (failure) return failure;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const failure = validateSchema(value[key], schema.additionalProperties, path + "." + key);
        if (failure) return failure;
      }
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return schemaError(path, "必须是数组");
    if (schema.minItems !== undefined && value.length < schema.minItems) return schemaError(path, "数量不能少于 " + schema.minItems);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return schemaError(path, "数量不能超过 " + schema.maxItems);
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validateSchema(value[index], schema.items, path + "." + index);
        if (failure) return failure;
      }
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return schemaError(path, "必须是字符串");
    if (schema.minLength !== undefined && value.length < schema.minLength) return schemaError(path, "长度不能少于 " + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return schemaError(path, "长度不能超过 " + schema.maxLength);
    if (schema.pattern) {
      let regex;
      try { regex = new RegExp(schema.pattern); } catch { return schemaError(path, "模式定义无效"); }
      if (!regex.test(value)) return schemaError(path, "格式不符合要求");
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return schemaError(path, "值不在允许枚举中");
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return schemaError(path, "必须是 canonical UUID");
    }
    return null;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return schemaError(path, "必须是有限数字");
    if (schema.type === "integer" && !Number.isInteger(value)) return schemaError(path, "必须是整数");
    if (schema.minimum !== undefined && value < schema.minimum) return schemaError(path, "不能小于 " + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) return schemaError(path, "不能大于 " + schema.maximum);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return schemaError(path, "必须大于 " + schema.exclusiveMinimum);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return schemaError(path, "必须小于 " + schema.exclusiveMaximum);
    return null;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return schemaError(path, "必须是布尔值");
    return null;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return schemaError(path, "值不在允许枚举中");
  return null;
}

function validateToolInput(name, input) {
  if (!hasOwn(TOOL_INPUT_SCHEMAS, name)) return schemaError("tool", "未知工具");
  const schema = TOOL_INPUT_SCHEMAS[name];
  if (name === "emit_fact" || name === "emit_finding") {
    const failure = validateSemanticPayloadFileTool(name, input, schema);
    if (failure) {
      if (failure.code === INVALID_PAYLOAD_CODE && hasOwn(TOOL_ERROR_CODES, name)) {
        return { ...failure, code: TOOL_ERROR_CODES[name], text: failure.text.replace("[" + INVALID_PAYLOAD_CODE + "]", "[" + TOOL_ERROR_CODES[name] + "]") };
      }
      return failure;
    }
    return null;
  }
  if (name === "submit_hub_decision") {
    const hubFailure = validateHubDecision(input);
    if (hubFailure) return hubFailure;
    // Large decisions may pass only payload_file; re-validate the expanded file body
    // so description/prompt minLength and role enum still apply.
    if (input && typeof input === "object" && typeof input.payload_file === "string") {
      const loaded = loadHubDecisionFromPayloadFile(input.payload_file);
      if (loaded.error) return loaded.error;
      const bodyFailure = validateSchema(loaded.decision, schema, "arguments");
      if (bodyFailure) {
        if (bodyFailure.code === INVALID_PAYLOAD_CODE && hasOwn(TOOL_ERROR_CODES, name)) {
          return { ...bodyFailure, code: TOOL_ERROR_CODES[name], text: bodyFailure.text.replace("[" + INVALID_PAYLOAD_CODE + "]", "[" + TOOL_ERROR_CODES[name] + "]") };
        }
        return bodyFailure;
      }
      return null;
    }
  }
  const failure = validateSchema(input, schema, "arguments");
  if (failure) {
    if (failure.code === INVALID_PAYLOAD_CODE && hasOwn(TOOL_ERROR_CODES, name)) {
      return { ...failure, code: TOOL_ERROR_CODES[name], text: failure.text.replace("[" + INVALID_PAYLOAD_CODE + "]", "[" + TOOL_ERROR_CODES[name] + "]") };
    }
    return failure;
  }
  return null;
}

function inputShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array(length=" + value.length + ")";
  if (typeof value === "string") return "string(length=" + value.length + ")";
  return typeof value;
}

function invalidNodeRef(path, value) {
  return { code: INVALID_NODE_REF_CODE, text: "[" + INVALID_NODE_REF_CODE + "] " + INVALID_NODE_REF_MESSAGE + " 字段 " + path + " 收到类型 " + inputShape(value) + "，请使用 canonical UUID。" };
}

function invalidReferenceBudget(path, count, limit) {
  return { code: INVALID_REFERENCE_BUDGET_CODE, text: "[" + INVALID_REFERENCE_BUDGET_CODE + "] " + INVALID_REFERENCE_BUDGET_MESSAGE + " 字段 " + path + " 收到 " + count + " 项，最多 " + limit + " 项。" };
}

function invalidRole(role, path) {
  // Shape only — never echo untrusted role text into the tool_result.
  const allow = availableRoleNames.length > 0 ? availableRoleNames.join(", ") : "(empty catalog)";
  return {
    code: ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidRole)},
    text: "[" + ${JSON.stringify(CONTROL_INPUT_ERROR_CODES.invalidRole)} + "] Hub 角色必须来自本轮 list_available_roles，字段 " + path + " 收到类型 " + inputShape(role) + "。允许的 name：" + allow + "。",
  };
}

function safeWorkspacePayloadPath(rel) {
  if (typeof rel !== "string" || !PAYLOAD_FILE_PATTERN.test(rel)) return null;
  return "/workspace/" + rel;
}

function loadPayloadFile(rel) {
  const path = safeWorkspacePayloadPath(rel);
  if (!path) {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 必须是 /workspace 下的安全相对路径" } };
  }
  let raw;
  let fileSize = 0;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("not_regular_file");
    fileSize = stat.size;
  } catch {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " 无法读取 payload_file=" + rel } };
  }
  if (fileSize > MAX_PAYLOAD_FILE_BYTES) {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 超过 512KiB" } };
  }
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " 无法读取 payload_file=" + rel } };
  }
  if (raw.length > MAX_PAYLOAD_FILE_BYTES) {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 超过 512KiB" } };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 不是合法 JSON" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 根必须是对象" } };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "payload_file")) {
    return { error: { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 内容不得再嵌套 payload_file" } };
  }
  return { payload: parsed };
}

function loadHubDecisionFromPayloadFile(rel) {
  const loaded = loadPayloadFile(rel);
  return loaded.error ? loaded : { decision: loaded.payload };
}

function semanticPayloadFailure(name, value) {
  if (name === "emit_fact") {
    if (typeof value?.title !== "string" || value.title.trim().length < 2) return schemaError("arguments.title", "至少需要 2 个非空白字符");
    if (typeof value?.description !== "string" || value.description.trim().length < 16) return schemaError("arguments.description", "至少需要 16 个非空白字符");
  }
  if (name === "emit_finding") {
    if (typeof value?.title !== "string" || value.title.trim().length < 8) return schemaError("arguments.title", "至少需要 8 个非空白字符");
    if (typeof value?.summary !== "string" || value.summary.trim().length < 32) return schemaError("arguments.summary", "至少需要 32 个非空白字符");
  }
  return null;
}

function validateSemanticPayloadFileTool(name, input, schema) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return schemaError("arguments", "必须是对象");
  const hasFile = hasOwn(input, "payload_file");
  const directKeys = Object.keys(input).filter((key) => key !== "payload_file");
  if (hasFile && directKeys.length > 0) return schemaError("arguments", "必须且只能提供直接字段或 payload_file 之一");
  if (!hasFile) {
    const failure = validateSchema(input, schema, "arguments");
    return failure || semanticPayloadFailure(name, input);
  }
  const loaded = loadPayloadFile(input.payload_file);
  if (loaded.error) return loaded.error;
  const failure = validateSchema(loaded.payload, schema, "arguments");
  return failure || semanticPayloadFailure(name, loaded.payload);
}

function validateHubDecision(input) {
  const args = input && typeof input === "object" ? input : {};
  const hasComplete = Object.prototype.hasOwnProperty.call(args, "complete") && args.complete !== undefined;
  const hasIntents = Object.prototype.hasOwnProperty.call(args, "intents") && args.intents !== undefined;
  const hasFile = Object.prototype.hasOwnProperty.call(args, "payload_file") && args.payload_file !== undefined;
  if ((hasComplete ? 1 : 0) + (hasIntents ? 1 : 0) + (hasFile ? 1 : 0) !== 1) {
    return { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " submit_hub_decision 必须且只能提供 complete、intents 或 payload_file 之一" };
  }
  let decisionArgs = args;
  if (hasFile) {
    const loaded = loadHubDecisionFromPayloadFile(args.payload_file);
    if (loaded.error) return loaded.error;
    decisionArgs = loaded.decision;
    const nestedComplete = Object.prototype.hasOwnProperty.call(decisionArgs, "complete") && decisionArgs.complete !== undefined;
    const nestedIntents = Object.prototype.hasOwnProperty.call(decisionArgs, "intents") && decisionArgs.intents !== undefined;
    if ((nestedComplete ? 1 : 0) + (nestedIntents ? 1 : 0) !== 1) {
      return { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " payload_file 内容必须且只能提供 complete 或 intents 之一" };
    }
  }
  const hasCompleteBody = Object.prototype.hasOwnProperty.call(decisionArgs, "complete") && decisionArgs.complete !== undefined;
  const references = [];
  if (hasCompleteBody) {
    const complete = decisionArgs.complete;
    if (!complete || typeof complete !== "object" || !Array.isArray(complete.from)) {
      return invalidNodeRef("complete.from", complete && complete.from);
    }
    if (complete.from.length > MAX_REFERENCES_PER_FROM) {
      return invalidReferenceBudget("complete.from", complete.from.length, MAX_REFERENCES_PER_FROM);
    }
    references.push(["complete.from", complete.from]);
  } else {
    if (!Array.isArray(decisionArgs.intents)) return invalidNodeRef("intents", decisionArgs.intents);
    const allowed = new Set(availableRoleNames);
    for (let index = 0; index < decisionArgs.intents.length; index += 1) {
      const intent = decisionArgs.intents[index];
      if (!intent || typeof intent !== "object" || !Array.isArray(intent.from)) {
        return invalidNodeRef("intents." + index + ".from", intent && intent.from);
      }
      if (typeof intent.role !== "string" || !allowed.has(intent.role)) {
        return invalidRole(intent.role, "intents." + index + ".role");
      }
      if (intent.from.length > MAX_REFERENCES_PER_FROM) {
        return invalidReferenceBudget("intents." + index + ".from", intent.from.length, MAX_REFERENCES_PER_FROM);
      }
      references.push(["intents." + index + ".from", intent.from]);
    }
  }
  const uniqueReferences = new Set();
  for (const [path, refs] of references) {
    for (let index = 0; index < refs.length; index += 1) {
      if (typeof refs[index] !== "string" || !NODE_REF_RE.test(refs[index])) {
        return invalidNodeRef(path + "." + index, refs[index]);
      }
      uniqueReferences.add(refs[index]);
    }
  }
  if (uniqueReferences.size > MAX_UNIQUE_REFERENCES) {
    return invalidReferenceBudget("intents", uniqueReferences.size, MAX_UNIQUE_REFERENCES);
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id == null) return;
  try {
    if (request.method === "initialize") {
      reply({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "deepsonar-control", version: "1" } } });
    } else if (request.method === "ping") {
      reply({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "tools/list") {
      const tools = [...allowed].filter((name) => hasOwn(definitions, name)).map((name) => ({ name, ...definitions[name] }));
      reply({ jsonrpc: "2.0", id: request.id, result: { tools } });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      if (!hasOwn(definitions, name)) {
        reply({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: "[" + UNKNOWN_TOOL_CODE + "] 未知控制工具" }],
            isError: true,
            error_code: UNKNOWN_TOOL_CODE,
          },
        });
      } else if (!allowed.has(name)) {
        reply({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: "[" + TOOL_NOT_ALLOWED_CODE + "] 本 Job 未启用控制工具：" + String(name) }],
            isError: true,
            error_code: TOOL_NOT_ALLOWED_CODE,
          },
        });
      } else {
      const input = name === "list_available_roles" && request.params?.arguments === undefined
        ? {}
        : request.params?.arguments;
      const validation = validateToolInput(name, input);
      if (validation) {
        reply({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: validation.text }],
            isError: true,
            error_code: validation.code,
          },
        });
      } else if (name === "list_available_roles") {
        reply({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ roles: availableRoles }) }] } });
      } else if (name === "list_shared_assets") {
        const defaultAccess = {
          mode: "readonly_mount",
          how: "read_mount_path",
          note: "There is no separate download tool. Open each asset mount_path/read_path with normal file tools; Scheduler pre-materialized bytes into the read-only mount (local or S3-compatible BlobStore).",
          copy_hint: "cp <mount_path> /workspace/<name>",
          forbid: [
            "Do not modify ${SHARED_ASSETS_READONLY_ROOT}",
            "Do not publish from .deepsonar/shared",
            "Do not fetch assets via HTTP/S3/curl",
          ],
        };
        let catalog = {
          version: 1,
          revision: null,
          readonly: true,
          readonly_root: ${JSON.stringify(SHARED_ASSETS_READONLY_ROOT)},
          access: defaultAccess,
          assets: [],
        };
        // Prefer mounted catalog; fall back to workspace snapshot copy written at provision.
        for (const path of [
          ${JSON.stringify(SHARED_ASSETS_MOUNT_CATALOG)},
          ${JSON.stringify(SHARED_ASSETS_WORKSPACE_CATALOG)},
        ]) {
          try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (parsed && typeof parsed === "object") {
              catalog = { ...catalog, ...parsed, access: parsed.access || defaultAccess };
              break;
            }
          } catch {}
        }
        const args = input || {};
        const matched = Array.isArray(catalog.assets) ? catalog.assets.filter((asset) =>
          (!args.scope || asset.scope === args.scope) && (!args.prefix || String(asset.key || "").startsWith(args.prefix))
        ).map((asset) => {
          const mount = asset.mount_path || asset.read_path || null;
          return {
            ...asset,
            mount_path: mount,
            read_path: asset.read_path || mount,
          };
        }) : [];
        const limit = Number.isInteger(args.limit) ? args.limit : 100;
        const offset = Number.isInteger(args.offset) ? args.offset : 0;
        const assets = matched.slice(offset, offset + limit);
        reply({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                ...catalog,
                readonly: true,
                readonly_root: catalog.readonly_root || ${JSON.stringify(SHARED_ASSETS_READONLY_ROOT)},
                access: catalog.access || defaultAccess,
                assets,
                total: matched.length,
                limit,
                offset,
                next_offset: offset + assets.length < matched.length ? offset + assets.length : null,
              }),
            }],
          },
        });
      } else {
        reply({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ status: "schema_validated", phase: "pending_scheduler_validation", tool: name }) }],
          },
        });
      }
      }
    } else if (request.method === "resources/list") {
      reply({ jsonrpc: "2.0", id: request.id, result: { resources: [] } });
    } else if (request.method === "prompts/list") {
      reply({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } });
    } else {
      reply({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    reply({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: String(error?.message || error) }],
        isError: true,
        error_code: "control_tool_error",
      },
    });
  }
});
`;
