# node

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

运行镜像内 Node 脚本/smoke、JSON 处理或 Agent 运行时。

## 选型依据

不要用临时 node 脚本替代官方包装入口（如 chrome-headless.sh）。

## 前置条件

PATH 中有 node。

## 调用方式

入口：`node`。

最小示例：

```bash
node -e "console.log(process.version)"
```

## 输出解释

脚本输出。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无输出 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 语法/模块错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | node 不在 PATH | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

执行 *-smoke.mjs；不替代 d8/clickhouse。

## 证据留存

脚本路径与输出。

## 版本与限制

镜像钉选 Node；见 tool-manifest。
