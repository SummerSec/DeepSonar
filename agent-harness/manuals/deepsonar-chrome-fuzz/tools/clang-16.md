# clang-16

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

chrome/clickhouse fuzz 钉选编译器。

## 选型依据

审计镜像可能是发行版 clang。

## 前置条件

fuzz 镜像。

## 调用方式

`clang-16`/`clang++-16`

最小示例：

```bash
clang-16 --version
```

## 输出解释

版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 非 fuzz 镜像 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 libFuzzer/AFL。

## 证据留存

-v 输出。

## 版本与限制

钉选 16。
