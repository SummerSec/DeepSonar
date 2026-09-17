# ClickHouse HTTP 接口

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

用 HTTP 打 query（smoke）。

## 选型依据

替代不了权限/协议边界之外的证据。

## 前置条件

server 起；127.0.0.1。

## 调用方式

curl 或 smoke mjs。

最小示例：

```bash
node /opt/deepsonar/clickhouse-test-smoke.mjs
```

## 输出解释

smoke 通过。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空响应 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 端口 | 修正参数/路径后重试 |
| 可重试失败 | 启动中 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | server 停 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 client 互证。

## 证据留存

smoke 日志。

## 版本与限制

同。
