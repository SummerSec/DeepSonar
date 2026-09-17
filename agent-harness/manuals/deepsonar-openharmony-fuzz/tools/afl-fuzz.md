# afl-fuzz

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

同 AFL++。

## 选型依据

同 AFL++。

## 前置条件

同。

## 调用方式

`afl-fuzz`

最小示例：

```bash
afl-fuzz -h 2>&1 | head
```

## 输出解释

同 AFL++。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 crash | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 参数错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

同。

## 证据留存

同。

## 版本与限制

OH fuzz。
