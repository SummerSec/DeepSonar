# openharmony-hdc.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

OH 镜像 hdc 包装。

## 选型依据

同 hdc。

## 前置条件

同。

## 调用方式

包装命令。

最小示例：

```bash
/opt/deepsonar/bin/openharmony-hdc.sh version || true
```

## 输出解释

版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无设备 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 参数 | 修正参数/路径后重试 |
| 可重试失败 | 重试 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

设备操作。

## 证据留存

输出。

## 版本与限制

包装。
