# libasan

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

ASan 运行时。

## 选型依据

需以 -fsanitize=address 构建。

## 前置条件

sanitizer 构建。

## 调用方式

运行构建产物。

最小示例：

```bash
ldconfig -p 2>/dev/null | rg asan || true
```

## 输出解释

崩溃报告。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无崩溃 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 未插桩 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无运行时 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

符号化。

## 证据留存

ASan 日志。

## 版本与限制

OH。
