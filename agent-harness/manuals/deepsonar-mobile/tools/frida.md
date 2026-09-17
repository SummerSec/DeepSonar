# frida

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

动态插桩 Android/iOS（在已 root/可调试前提下）。

## 选型依据

无 frida-server/权限时停止；禁止把静态结果写成动态。

## 前置条件

匹配 arch 的 frida-server；adb/ios 通道。

## 调用方式

`frida`/`frida-ps`；server 位于 /opt/deepsonar/frida-server。

最小示例：

```bash
frida --version
```

## 输出解释

进程列表/脚本结果。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无进程 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 版本不匹配 | 修正参数/路径后重试 |
| 可重试失败 | server 崩溃 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未部署 server/无设备 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

adb push server → frida → objection。

## 证据留存

版本、脚本、设备、日志。标注：真机。

## 版本与限制

venv 钉选。
