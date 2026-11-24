import { readFileSync } from "node:fs";

/**
 * #1221 review：文档文案守卫必须能在文档快车道运行。
 *
 * 原先这类扫描只存在于 Web 的重型 gate（`accent-theme.test.ts`）。文档快车道只跑
 * `docs-freshness`，所以只改 DESIGN.md / docs 的 PR 绕过了守卫。这里把扫描抽成
 * 共享模块，两个入口都调用同一份实现：Web gate 扫更宽的范围，`docs-freshness`
 * 扫窄的文档范围。
 *
 * 输入是显式文件列表（不遍历目录），便于用合成坏文件做自检。
 */
export function findBannedCopy({ files, pattern }) {
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(text)) hits.push(file);
  }
  return hits;
}
