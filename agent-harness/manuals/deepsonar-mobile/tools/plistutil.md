# plistutil

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

转换/查看 plist（IPA 静态）。

## 选型依据

替代不了设备证据。

## 前置条件

plist 文件。

## 调用方式

`plistutil`/`plutil` 视镜像。

最小示例：

```bash
plistutil -h 2>&1 | head || true
```

## 输出解释

xml/json。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 坏 plist | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

unzip IPA → plistutil。

## 证据留存

文件哈希与转换结果。

## 版本与限制

mobile。
