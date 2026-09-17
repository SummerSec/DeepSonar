# droidasc

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

大 APK 上按需查类、Manifest、引用，避免全量反编译。

## 选型依据

需要完整源码视图用 jadx；禁止 `--gui`；不得把 ASC 叙述冒充设备/流量结果。

## 前置条件

APK 路径。

## 调用方式

`droidasc getclass|getmanifest|findrefs …`（以 `--help` 为准）。

最小示例：

```bash
droidasc --help | head
```

## 输出解释

查询结果；无命中是正常无结果。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无命中 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 错误子命令 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装 droidasc | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

定位后 jadx 深挖；动态用 adb/frida。

## 证据留存

子命令、APK 哈希、结果摘录。

## 版本与限制

droidasc==钉选；禁 GUI。
