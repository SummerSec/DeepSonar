# llvm-symbolizer

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

符号化 ASan/崩溃栈。

## 选型依据

无二进制符号时效果差。

## 前置条件

带 debug 的二进制。

## 调用方式

管道喂栈或 `llvm-symbolizer`。

最小示例：

```bash
llvm-symbolizer --version || true
```

## 输出解释

符号化作用域。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无法符号化 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 路径 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

复现崩溃后符号化。

## 证据留存

原始栈+符号化栈。

## 版本与限制

OH/fuzz。
