# git-lfs

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

拉取 LFS 大文件。

## 选型依据

普通文本不需要。

## 前置条件

git-lfs 已装；egress。

## 调用方式

`git lfs install`/`git lfs pull`

最小示例：

```bash
git lfs version
```

## 输出解释

版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 未 track | 修正参数/路径后重试 |
| 可重试失败 | 网络 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 LFS | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接构建。

## 证据留存

LFS oid。

## 版本与限制

OH 镜像。
