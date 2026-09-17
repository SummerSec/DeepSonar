# gdb

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

主机侧调试崩溃（非设备协议）。

## 选型依据

不要当 hdc/adb 替代。

## 前置条件

二进制与可能的 core。

## 调用方式

`gdb ./bin`

最小示例：

```bash
gdb --version | head
```

## 输出解释

调试会话。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 无符号 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 gdb | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

sanitizer 复现。

## 证据留存

会话日志。

## 版本与限制

OH audit/fuzz。
