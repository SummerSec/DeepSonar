# clickhouse-audit-env.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

检查 CH 审计工具链。

## 选型依据

无 server。

## 前置条件

clickhouse-audit。

## 调用方式

`--check`

最小示例：

```bash
/opt/deepsonar/bin/clickhouse-audit-env.sh --check
```

## 输出解释

就绪。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 环境 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

cmake/ninja。

## 证据留存

日志。

## 版本与限制

包装。
