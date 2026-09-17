# jq

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

解析或过滤 JSON 清单、工具机读输出、配置。

## 选型依据

不要当通用文本处理；XML/smali 用对应工具。

## 前置条件

输入为 JSON。

## 调用方式

入口：`jq`。

最小示例：

```bash
echo '{"a":1}' | jq -r .a
```

## 输出解释

过滤后的 JSON/文本；语法错误非 0。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 过滤结果 null/空 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 非法 JSON 或 filter | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无输入文件 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

常接 tool-manifest、droidasc/hdc 的 JSON 输出。

## 证据留存

保存 filter 表达式与关键输出。

## 版本与限制

apt jq。
