# pkg-config

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

查询已装库编译参数。

## 选型依据

不是分析器。

## 前置条件

.pc 文件存在。

## 调用方式

`pkg-config --libs --cflags <name>`

最小示例：

```bash
pkg-config --exists zlib && pkg-config --libs zlib
```

## 输出解释

cflags/libs 字符串。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 包不存在退出非0 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 名字错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未安装 .pc | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接入 gcc/clang 编译行。

## 证据留存

包名与输出。

## 版本与限制

kali/fuzz 镜像。
