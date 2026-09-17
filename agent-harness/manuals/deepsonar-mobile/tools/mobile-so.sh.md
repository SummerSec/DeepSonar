# mobile-so.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

.so 检查包装（readelf/r2/LIEF）。

## 选型依据

Java 层用 jadx。

## 前置条件

.so。

## 调用方式

`/opt/deepsonar/bin/mobile-so.sh`

最小示例：

```bash
/opt/deepsonar/bin/mobile-so.sh --help || true
```

## 输出解释

ELF 摘要。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 非 ELF | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

深挖 r2。

## 证据留存

SO 哈希与摘要。

## 版本与限制

包装。
