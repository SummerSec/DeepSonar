# llvm 工具集

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

llvm-nm、opt 等 LLVM 工具。

## 选型依据

日常符号优选用 llvm-nm/nm。

## 前置条件

LLVM 已装。

## 调用方式

`llvm-nm`/`llvm-objdump` 等。

最小示例：

```bash
llvm-nm --version || true; llvm-config --version || true
```

## 输出解释

版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 子命令错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 clang 构建产物分析。

## 证据留存

命令输出。

## 版本与限制

审计/fuzz。
