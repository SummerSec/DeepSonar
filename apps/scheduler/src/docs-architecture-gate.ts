/** #741 文档身份与需求追溯校验；不从源码推断规范是否已满足。 */
export function normalizeDocPath(relative: string): string {
  return relative.replaceAll("\\", "/");
}

const ID_SOURCE = "(?:(?:FR|NFR)-[A-Z][A-Z0-9]*-[0-9]{3}|(?:IR|CON)-[0-9]{3})";
const ID = new RegExp(`^${ID_SOURCE}$`);

/** 示例不是定义或引用，支持 Markdown 的两种围栏与 CRLF。 */
export function stripMarkdownFences(markdown: string): string {
  const lines: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export function auditRequirements(spec: string, trace: string, references: readonly string[] = [], deprecatedIds: readonly string[] = []): string[] {
  const errors: string[] = [];
  const definitions = new Set<string>();
  const specBody = stripMarkdownFences(spec);
  for (const match of specBody.matchAll(/^###\s+((?:FR|NFR|IR|CON)-\S+)(?:\s|$)/gm)) {
    const id = match[1]!;
    if (!ID.test(id)) errors.push(`无效定义: ${id}`);
    else if (definitions.has(id)) errors.push(`重复定义: ${id}`);
    else definitions.add(id);
  }
  if (!definitions.size) errors.push("没有需求定义");
  for (const id of deprecatedIds) {
    const block = specBody.split(/^###\s+/m).find((section) => section.startsWith(`${id}\n`) || section.startsWith(`${id} `));
    if (!block || !/\*\*实现状态\*\*[：:]\s*已废弃/.test(block)) errors.push(`已废弃 ID 必须保留废弃条目，不得复用: ${id}`);
  }

  const rows = new Set<string>();
  const traceBody = stripMarkdownFences(trace);
  for (const line of traceBody.split("\n")) {
    if (!/^\|\s*(?:FR|NFR|IR|CON)-/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const id = cells[0]!;
    if (!ID.test(id)) errors.push(`无效追溯 ID: ${id}`);
    if (!definitions.has(id)) errors.push(`未定义需求: ${id}`);
    if (rows.has(id)) errors.push(`重复追溯: ${id}`);
    rows.add(id);
    if (cells.length !== 5 || cells.some((cell) => !cell)) errors.push(`追溯空字段或列数错误: ${id}`);
  }
  for (const id of definitions) if (!rows.has(id)) errors.push(`缺少追溯: ${id}`);

  for (const body of [specBody, traceBody, ...references.map(stripMarkdownFences)]) {
    for (const match of body.matchAll(new RegExp(`\\b${ID_SOURCE}\\b`, "g"))) {
      if (!definitions.has(match[0])) errors.push(`未定义引用: ${match[0]}`);
    }
  }
  return [...new Set(errors)];
}
