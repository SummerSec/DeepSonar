# objection

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

基于 Frida 的探索型运行时助手。

## 选型依据

无 Frida 条件时不用。

## 前置条件

frida 可用。

## 调用方式

`objection`

最小示例：

```bash
objection --help | head
```

## 输出解释

交互/脚本输出。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | attach 失败 | 修正参数/路径后重试 |
| 可重试失败 | 重附 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 frida | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 frida 脚本互补。

## 证据留存

会话日志。

## 版本与限制

venv。
