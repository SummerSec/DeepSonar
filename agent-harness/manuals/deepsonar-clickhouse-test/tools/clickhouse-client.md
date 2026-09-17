# clickhouse-client

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

连接 server 执行 SQL。

## 选型依据

一次性分析可优先 clickhouse-local。

## 前置条件

server 已在 127.0.0.1 监听。

## 调用方式

`clickhouse-client --query`

最小示例：

```bash
clickhouse-client --query "SELECT version()"
```

## 输出解释

结果集。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空结果 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | SQL/认证 | 修正参数/路径后重试 |
| 可重试失败 | 连接拒绝可重试 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | server 未起 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 server 包装组合。

## 证据留存

SQL 与结果。

## 版本与限制

同 clickhouse。
