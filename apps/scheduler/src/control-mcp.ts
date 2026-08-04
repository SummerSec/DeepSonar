import {
  CANONICAL_UUID_PATTERN,
  ControlToolInputSchemasJson,
  HUB_REFERENCE_LIMITS,
} from "@deepsonar/shared-types";
import {
  CONTROL_INPUT_ERROR_CODES,
  INVALID_PAYLOAD_MESSAGE,
  INVALID_NODE_REF_MESSAGE,
  INVALID_REFERENCE_BUDGET_MESSAGE,
} from "./control-input.js";

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
} as const;

export const CONTROL_MCP_SERVER = String.raw`import readline from "node:readline";

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
};
const TOOL_INPUT_SCHEMAS = ${JSON.stringify(ControlToolInputSchemasJson)};
const MAX_REFERENCES_PER_FROM = ${HUB_REFERENCE_LIMITS.perFrom};
const MAX_UNIQUE_REFERENCES = ${HUB_REFERENCE_LIMITS.totalUnique};
const NODE_REF_RE = new RegExp(CANONICAL_UUID_PATTERN, "i");
const hasOwn = (object, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);


const descriptions = {
  list_available_roles: "返回当前 Hub Job 可派发的数据库角色。只使用返回的 name，不得猜测或使用固定角色清单。",
  emit_progress: "增量上报当前动作或阶段进展。可在执行中多次调用。",
  emit_fact: "把一个新的、可验证的增量事实实时写入任务画布。Hub 回弹补证 Job 可附带 verification 结构化证据。可多次调用。",
  emit_finding: "实时提交一个有证据的安全 Finding；调度器负责去重和决定是否验证。可多次调用。",
  submit_hub_decision: "提交本轮 Hub 的 complete 或 intents 决策，二者必须且只能提供一个。from 必须填写当前 YAML root_id/fact/finding 节点的 UUID 值，不能填写字段名 root_id、别名或占位符。",
  mark_job_done: "提交本 Job 的最终摘要；verify 系统角色还必须提交 verdict（confirmed|rework|needs_human；兼容 false_positive→rework）。每个 Job 最后调用一次。",
  request_human: "只有缺少必要授权、凭据或高风险操作必须人工确认时调用。",
};
const definitions = Object.fromEntries(
  Object.keys(TOOL_INPUT_SCHEMAS).map((name) => [name, {
    description: hasOwn(descriptions, name) ? descriptions[name] : "DeepSonar 控制工具。",
    inputSchema: TOOL_INPUT_SCHEMAS[name],
  }]),
);

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
  if (name === "submit_hub_decision") {
    const hubFailure = validateHubDecision(input);
    if (hubFailure) return hubFailure;
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

function validateHubDecision(input) {
  const args = input && typeof input === "object" ? input : {};
  const hasComplete = Object.prototype.hasOwnProperty.call(args, "complete");
  const hasIntents = Object.prototype.hasOwnProperty.call(args, "intents");
  if ((hasComplete ? 1 : 0) + (hasIntents ? 1 : 0) !== 1) {
    return { code: INVALID_PAYLOAD_CODE, text: "[" + INVALID_PAYLOAD_CODE + "] " + INVALID_PAYLOAD_MESSAGE + " submit_hub_decision 必须且只能提供 complete 或 intents 之一" };
  }
  const references = [];
  if (hasComplete) {
    const complete = args.complete;
    if (!complete || typeof complete !== "object" || !Array.isArray(complete.from)) {
      return invalidNodeRef("complete.from", complete && complete.from);
    }
    if (complete.from.length > MAX_REFERENCES_PER_FROM) {
      return invalidReferenceBudget("complete.from", complete.from.length, MAX_REFERENCES_PER_FROM);
    }
    references.push(["complete.from", complete.from]);
  } else {
    if (!Array.isArray(args.intents)) return invalidNodeRef("intents", args.intents);
    for (let index = 0; index < args.intents.length; index += 1) {
      const intent = args.intents[index];
      if (!intent || typeof intent !== "object" || !Array.isArray(intent.from)) {
        return invalidNodeRef("intents." + index + ".from", intent && intent.from);
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
