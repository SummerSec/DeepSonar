# openharmony-fuzz-build.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

构建 fuzz/sanitizer 目标。

## 选型依据

玩具目标不能冒充。

## 前置条件

源码/harness。

## 调用方式

包装构建。

最小示例：

```bash
/opt/deepsonar/bin/openharmony-fuzz-env.sh --check
```

## 输出解释

fuzz 二进制。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译失败 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺源码 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

libFuzzer/AFL 运行。

## 证据留存

二进制与种子。

## 版本与限制

包装。
