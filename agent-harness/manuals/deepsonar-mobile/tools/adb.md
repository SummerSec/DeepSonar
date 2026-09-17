# adb + mobile-adb.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

Android 设备/模拟器：devices/shell/push/pull/install/forward。

## 选型依据

空 devices 不得编造；静态分析用 jadx/droidasc。

## 前置条件

设备授权或 host-mapped；包装 `/opt/deepsonar/bin/adb`。

## 调用方式

`adb devices`/`shell`；或 `mobile-adb.sh`。

最小示例：

```bash
adb version && adb devices
```

## 输出解释

设备列表；空列表→needs_human/inconclusive。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无设备（正常缺条件） | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 未授权 | 修正参数/路径后重试 |
| 可重试失败 | adb server 可重启 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 adb | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

install → frida/objection。

## 证据留存

devices 输出、命令、序列号。

## 版本与限制

platform-tools 钉选。标注：真机依赖实测。
