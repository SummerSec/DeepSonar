# apkeep

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

按策略拉取 APK 样本。

## 选型依据

已有本地 APK 不必拉取；遵守 egress。

## 前置条件

egress；目标应用 id。

## 调用方式

`apkeep`

最小示例：

```bash
apkeep --help | head
```

## 输出解释

下载文件。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | id 错误 | 修正参数/路径后重试 |
| 可重试失败 | 商店瞬时 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 断网 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

下载后 droidasc/jadx。

## 证据留存

来源 URL/id 与哈希。

## 版本与限制

钉选。
