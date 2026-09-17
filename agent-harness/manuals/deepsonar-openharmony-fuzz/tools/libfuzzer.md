# libFuzzer

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

OH/通用 libFuzzer。

## 选型依据

同 libFuzzer-16。

## 前置条件

harness。

## 调用方式

同 libFuzzer。

最小示例：

```bash
clang --version | head -1
```

## 输出解释

同左。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无崩溃 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译失败 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺 rt | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

同左。

## 证据留存

同左。

## 版本与限制

OH fuzz。
