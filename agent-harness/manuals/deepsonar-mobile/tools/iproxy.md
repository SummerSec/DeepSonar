# iproxy

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

端口转发到 iOS 设备。

## 选型依据

无设备时不用。

## 前置条件

UDID；本地端口。

## 调用方式

`iproxy local:remote`

最小示例：

```bash
iproxy -h 2>&1 | head || true
```

## 输出解释

转发进程。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 端口占用 | 修正参数/路径后重试 |
| 可重试失败 | 重连 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无设备 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接本地客户端。

## 证据留存

端口映射。

## 版本与限制

libimobiledevice。
