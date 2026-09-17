# git partial clone

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

大仓（Chromium/ClickHouse）用 filter/sparse 降带宽。

## 选型依据

小仓直接 clone。

## 前置条件

git 2.x；远端支持 filter。

## 调用方式

`git clone --filter=blob:none --sparse`

最小示例：

```bash
git clone --filter=blob:none --depth=1 <url> /tmp/src
```

## 输出解释

浅/部分对象库。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 远端不支持 | 修正参数/路径后重试 |
| 可重试失败 | 网络 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | egress | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 clang 审计。

## 证据留存

clone 参数与 HEAD。

## 版本与限制

git 能力。
