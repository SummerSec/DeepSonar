# ideviceinstaller

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

安装/列出 iOS 应用（能力范围内）。

## 选型依据

无设备停；不做越狱承诺。

## 前置条件

UDID。

## 调用方式

`ideviceinstaller -l`

最小示例：

```bash
ideviceinstaller --help | head
```

## 输出解释

应用列表。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无应用 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 权限 | 修正参数/路径后重试 |
| 可重试失败 | 连接 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无设备 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 plistutil。

## 证据留存

命令输出。

## 版本与限制

host tools。
