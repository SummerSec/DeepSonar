# afl-clang-fast

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

AFL 插桩编译。

## 选型依据

普通 clang 构建无插桩。

## 前置条件

源码。

## 调用方式

`afl-clang-fast`/`++`

最小示例：

```bash
afl-clang-fast -h 2>&1 | head
```

## 输出解释

插桩二进制。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译失败 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

afl-fuzz。

## 证据留存

编译命令。

## 版本与限制

OH fuzz。
