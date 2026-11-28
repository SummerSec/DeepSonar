/**
 * #1219：知识条目的适用软件版本判定（无依赖，便于单测）。
 *
 * 条目用 `sw:<version>` 关键字声明适用范围；没有任何声明就是「通用」，对每个版本都适用。
 * 未指定版本时不筛选，保持旧调用方行为不变。
 */
export function appliesToSoftwareVersion(
  keywords: readonly string[] | undefined,
  softwareVersion: string,
): boolean {
  if (!softwareVersion) return true;
  const declared = (keywords ?? []).filter((tag) => tag.startsWith("sw:")).map((tag) => tag.slice(3));
  return declared.length === 0 || declared.includes(softwareVersion);
}
