# androguard

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

Python API/CLI 做 APK 结构分析。

## 选型依据

大规模按需查询优先 droidasc。

## 前置条件

mobile venv。

## 调用方式

`androguard`

最小示例：

```bash
androguard --help | head
```

## 输出解释

分析输出。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 坏 APK | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 jadx 对照。

## 证据留存

脚本与输出。

## 版本与限制

mobile venv 钉选。
