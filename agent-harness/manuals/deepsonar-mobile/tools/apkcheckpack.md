# apkcheckpack

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

Agent 主动做加固/SDK 指纹识别。

## 选型依据

不是平台自动扫描入口；不替代人工结论。

## 前置条件

APK。

## 调用方式

`apkcheckpack` 包装。

最小示例：

```bash
apkcheckpack --help | head || /opt/deepsonar/bin/apkcheckpack --help | head
```

## 输出解释

指纹/打包信息。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 未识别 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 坏文件 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

结果指导是否脱壳/换工具。

## 证据留存

输出全文与 APK 哈希。

## 版本与限制

钉选。
