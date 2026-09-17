# llvm-nm

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

查看 bitcode/对象符号。

## 选型依据

ELF 动态符优先 nm/readelf。

## 前置条件

目标文件。

## 调用方式

`llvm-nm`

最小示例：

```bash
llvm-nm --help | head
```

## 输出解释

符号表。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无符号 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 文件类型不符 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 objdump。

## 证据留存

符号摘录。

## 版本与限制

审计镜像。
