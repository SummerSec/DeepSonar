# clickhouse-local

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

无 server 本地跑 SQL/复现。

## 选型依据

需要完整服务器行为时用 server。

## 前置条件

官方二进制。

## 调用方式

`clickhouse-local --query`

最小示例：

```bash
clickhouse-local --query "SELECT 1"
```

## 输出解释

结果。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | SQL | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺二进制 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

fuzz crash 复现入口。

## 证据留存

SQL/输入文件。

## 版本与限制

同。
