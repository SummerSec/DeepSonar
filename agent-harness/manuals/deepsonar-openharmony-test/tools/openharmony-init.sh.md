# openharmony-init.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

同步 OH 源码清单。

## 选型依据

已有源码树则跳过。

## 前置条件

大磁盘；egress。

## 调用方式

`/opt/deepsonar/bin/openharmony-init.sh`

最小示例：

```bash
/opt/deepsonar/bin/openharmony-env.sh --check
```

## 输出解释

同步日志。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 清单 | 修正参数/路径后重试 |
| 可重试失败 | 网络 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 磁盘 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

build。

## 证据留存

manifest 修订。

## 版本与限制

包装。
