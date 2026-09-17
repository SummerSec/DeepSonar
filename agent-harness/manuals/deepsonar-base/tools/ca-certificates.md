# ca-certificates

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

TLS 校验依赖；通常被 curl/npm/git 间接使用，不单独作为分析工具。

## 选型依据

不是 Agent 主分析入口。

## 前置条件

系统证书包已装。

## 调用方式

无直接分析入口；故障时检查 `/etc/ssl/certs`。

最小示例：

```bash
test -d /etc/ssl/certs && echo certs_ok
```

## 输出解释

存在性检查。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 无 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 证书目录缺失导致 TLS 失败 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 curl/git 组合。

## 证据留存

TLS 失败时记录验证步骤。

## 版本与限制

apt 钉选；属内部支撑，写入手册以满足清单覆盖。
