# cppcheck

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

C/C++ 静态检查补充。

## 选型依据

告警需确认。

## 前置条件

源码。

## 调用方式

`cppcheck --enable=all …`

最小示例：

```bash
cppcheck --version
```

## 输出解释

告警列表。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无告警 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 路径 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 clang-tidy。

## 证据留存

报告。

## 版本与限制

OH audit。
