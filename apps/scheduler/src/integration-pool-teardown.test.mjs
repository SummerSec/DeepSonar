import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const targets = [
  { name: "overview", file: "./domains/dashboard/overview.integration.test.ts", hasAppClose: true },
  { name: "quality", file: "./domains/dashboard/quality.integration.test.ts", hasAppClose: true },
  { name: "export", file: "./transfer/export.integration.test.ts", hasAppClose: false },
];

for (const { name, file, hasAppClose } of targets) {
  test(`${name} 在 teardown 末尾显式关闭共享 sql 池`, () => {
    const source = read(file);
    assert.match(source, /sql\.end\(/, `${name}: 缺少 sql.end(...) 调用`);
    assert.doesNotMatch(source, /process\.exit/, `${name}: 不允许用 process.exit 强制退出`);

    const endIndex = source.indexOf("sql.end(");
    if (hasAppClose) {
      const closeIndex = source.lastIndexOf("app.close()");
      assert.ok(closeIndex >= 0, `${name}: 应存在 app.close()`);
      assert.ok(endIndex > closeIndex, `${name}: sql.end 必须在 app.close() 之后`);
    } else {
      const finallyIndex = source.lastIndexOf("finally");
      assert.ok(finallyIndex >= 0, `${name}: 应存在 finally 块`);
      assert.ok(endIndex > finallyIndex, `${name}: sql.end 必须位于 finally 内`);
    }
  });
}

test("db.ts 的 idle_timeout 仍引用 config.db.idleTimeoutSec", () => {
  const source = read("./db.ts");
  assert.match(
    source,
    /idle_timeout:\s*config\.db\.idleTimeoutSec/,
    "不得偷偷改动生产 idle_timeout 配置",
  );
});
