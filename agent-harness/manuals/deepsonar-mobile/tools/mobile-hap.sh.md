# mobile-hap.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

HAP 静态辅助。

## 选型依据

设备行为用 hdc。

## 前置条件

HAP 文件。

## 调用方式

`/opt/deepsonar/bin/mobile-hap.sh`

最小示例：

```bash
/opt/deepsonar/bin/mobile-hap.sh --help || true
```

## 输出解释

结构信息。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 坏 HAP | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

unzip/jq → hdc install。

## 证据留存

HAP 哈希。

## 版本与限制

包装。
