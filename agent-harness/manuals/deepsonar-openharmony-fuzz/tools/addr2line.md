# addr2line

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

地址转源码行。

## 选型依据

无 debug 信息时无用。

## 前置条件

ELF + 地址。

## 调用方式

`addr2line -e bin addr`

最小示例：

```bash
addr2line --help | head
```

## 输出解释

文件:行号。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | ??:0 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 错地址 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 sanitizer 栈。

## 证据留存

地址与行号。

## 版本与限制

binutils。
