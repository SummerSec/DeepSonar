# clang/clang++

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

C/C++ 编译、审计构建、带 sanitizer 的复现。

## 选型依据

纯阅读可用 rg；运行浏览器用 chrome-test。

## 前置条件

源码与依赖；编译数据库可选。

## 调用方式

`clang`/`clang++`；常用 `-Wall -O1 -g`。

最小示例：

```bash
clang --version
```

## 输出解释

版本；编译产物。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 工具链缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

clang-tidy / scan-build / 运行二进制。

## 证据留存

clang -v、编译命令、目标 commit。

## 版本与限制

审计镜像 Debian clang；fuzz 可能 clang-16。
