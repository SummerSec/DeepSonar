# clickhouse 官方二进制

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

执行 SQL、local 模式或起 server。

## 选型依据

不要 apt 装非钉选包；审计镜像默认无 server。

## 前置条件

clickhouse-* 镜像；看 tool-manifest.clickhouse。

## 调用方式

包装：`clickhouse-test-env.sh`、`clickhouse-server.sh`、`clickhouse-local`。

最小示例：

```bash
/opt/deepsonar/bin/clickhouse-test-env.sh --check
```

## 输出解释

版本与就绪。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 查询空表 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | SQL 错 | 修正参数/路径后重试 |
| 可重试失败 | server 启动竞态 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 非官方二进制 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

local 快查 → server 集成 → 保存结果集。

## 证据留存

版本、SQL、结果、exit。

## 版本与限制

钉选 LTS 见 manifest。
