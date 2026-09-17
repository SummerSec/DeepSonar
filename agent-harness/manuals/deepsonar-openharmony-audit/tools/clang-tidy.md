# clang-tidy

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

C++ 静态检查与缺陷模式提示。

## 选型依据

不替代人工确认；无 compile_commands 时结果可能弱。

## 前置条件

compile_commands.json 更佳。

## 调用方式

`clang-tidy file.cpp -- [compile args]`

最小示例：

```bash
clang-tidy --version
```

## 输出解释

诊断列表；告警≠确认漏洞。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无告警 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 缺编译参数 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 clang-tidy | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 rg/人工审阅组合。

## 证据留存

检查命令与告警摘录。

## 版本与限制

审计镜像。
