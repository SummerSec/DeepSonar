# v8_json_libfuzzer

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

镜像预置 libFuzzer 目标（JSON）。

## 选型依据

不要用假目标。

## 前置条件

chrome-fuzz；corpus。

## 调用方式

`/opt/deepsonar/bin/v8_json_libfuzzer`

最小示例：

```bash
/opt/deepsonar/bin/v8_json_libfuzzer -help=1 | head
```

## 输出解释

fuzz 统计/crash。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 crash | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 参数 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺二进制 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

crash → d8。

## 证据留存

crash 与 help/version。

## 版本与限制

manifest。
