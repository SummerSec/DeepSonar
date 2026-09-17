# idevice_id

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

列出 iOS 设备 UDID（Linux host）。

## 选型依据

无设备时不要编造；无 Xcode。

## 前置条件

usbmuxd/设备。

## 调用方式

`idevice_id -l`

最小示例：

```bash
idevice_id -l || true
```

## 输出解释

UDID 列表；空→needs_human。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无设备 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 线缆/信任 | 修正参数/路径后重试 |
| 可重试失败 | 重启 usbmuxd | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 工具缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

ideviceinstaller/iproxy。

## 证据留存

UDID 列表。标注：真机依赖。

## 版本与限制

libimobiledevice。
