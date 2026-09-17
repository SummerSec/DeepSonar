# AFL++

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

基于插桩的外部 fuzz。

## 选型依据

无种子/harness 不要空跑；有 libFuzzer 目标时可优先进程内。

## 前置条件

afl-clang-fast 构建；seeds。

## 调用方式

`afl-fuzz -i seeds -o out -- ./target @@`

最小示例：

```bash
afl-fuzz -h 2>&1 | head
```

## 输出解释

queue/crashes 目录。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 crash | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 目标非插桩 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺 AFL | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

crash → 复现。

## 证据留存

out/crashes、命令行。

## 版本与限制

fuzz 镜像。
