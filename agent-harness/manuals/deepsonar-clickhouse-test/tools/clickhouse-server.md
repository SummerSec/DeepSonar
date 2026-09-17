# clickhouse-server.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

启动沙箱内官方 server。

## 选型依据

审计镜像不要强行装 server。

## 前置条件

clickhouse-test；沙箱配置脚本。

## 调用方式

`/opt/deepsonar/bin/clickhouse-server.sh`

最小示例：

```bash
/opt/deepsonar/bin/clickhouse-test-env.sh --check
```

## 输出解释

监听与日志。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 配置错误 | 修正参数/路径后重试 |
| 可重试失败 | 端口占用 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺二进制 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

client 查询。

## 证据留存

配置路径与日志。

## 版本与限制

钉选。
