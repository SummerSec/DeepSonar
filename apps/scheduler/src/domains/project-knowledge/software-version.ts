/**
 * #1219：知识条目的适用软件版本判定（无依赖，便于单测）。
 *
 * 条目用关键字声明适用范围，两种写法都接受：
 * - `sw:<software>:<version>`：带软件标识（推荐，同一项目里两个同名版本也能区分）
 * - `sw:<version>`：只约束版本，不限软件（历史写法，继续兼容）
 *
 * 判定结果三态：
 * - `applicable`：没有声明，或声明的软件/版本与可信上下文一致
 * - `inapplicable`：声明存在且与可信上下文冲突（默认推荐必须排除）
 * - `unknown`：条目有版本约束，但当前没有可信上下文，无法判断适用性
 *
 * 未知时不能当作适用：调用方（检索）把这类条目显式标成 `applicability:'unknown'`，
 * 由 Agent 自己决定要不要按历史参考，而不是让平台冒充「已验证适用」。
 */
export type ApplicabilityContext = { software?: string; version?: string };
export type Applicability = "applicable" | "inapplicable" | "unknown";

type Declaration = { software?: string; version: string };

function declarations(keywords: readonly string[] | undefined): Declaration[] {
  const found: Declaration[] = [];
  for (const keyword of keywords ?? []) {
    if (!keyword.startsWith("sw:")) continue;
    const parts = keyword.slice(3).split(":");
    if (parts.length >= 2) found.push({ software: parts[0]!.trim(), version: parts.slice(1).join(":").trim() });
    else if (parts[0]!.trim()) found.push({ version: parts[0]!.trim() });
  }
  return found;
}

export function evaluateApplicability(
  keywords: readonly string[] | undefined,
  context: ApplicabilityContext,
): Applicability {
  const declared = declarations(keywords);
  if (declared.length === 0) return "applicable";
  const software = (context.software ?? "").trim();
  const version = (context.version ?? "").trim();
  if (!version) return "unknown";
  const matched = declared.some((entry) => entry.version === version
    && (!entry.software || !software || entry.software === software));
  return matched ? "applicable" : "inapplicable";
}

/** 只有「显式声明且与可信上下文一致」才算已验证适用；未知不冒充适用。 */
export function appliesToSoftwareVersion(
  keywords: readonly string[] | undefined,
  softwareVersion: string,
): boolean {
  return evaluateApplicability(keywords, { version: softwareVersion }) !== "inapplicable";
}
