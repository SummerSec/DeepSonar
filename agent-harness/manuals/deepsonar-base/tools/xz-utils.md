# xz / unxz

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

处理 .xz 压缩资产（如 frida-server 包）。

## 选型依据

普通 zip 用 unzip。

## 前置条件

输入为 xz。

## 调用方式

入口：`xz`/`unxz`。

最小示例：

```bash
xz -t /path/to/file.xz && echo ok
```

## 输出解释

测试/解压状态。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 损坏归档 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 文件缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

解压后 `file`/安装到 /opt/deepsonar。

## 证据留存

归档哈希与命令。

## 版本与限制

apt xz-utils。
