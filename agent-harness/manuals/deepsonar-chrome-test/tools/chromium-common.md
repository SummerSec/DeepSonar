# chromium-common

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

chromium 运行依赖（内部支撑）。

## 选型依据

不要直接调用。

## 前置条件

随 chrome-test 安装。

## 调用方式

无直接入口。

最小示例：

```bash
dpkg -l chromium-common | tail -1 || true
```

## 输出解释

包存在性。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 无 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 包装依赖缺失会导致 chromium 启动失败 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

被 chromium 使用。

## 证据留存

启动失败时记录依赖检查。

## 版本与限制

与 chromium 同钉。
