# hdc + wrappers

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

OpenHarmony/Harmony 设备协议：list targets/shell/file/install/hilog。

## 选型依据

空 targets 不得编造；主机静态用 OH audit。

## 前置条件

设备或映射；`/opt/deepsonar/bin/hdc`。

## 调用方式

`hdc list targets` 等；OH 镜像用 openharmony-hdc.sh。

最小示例：

```bash
hdc version || /opt/deepsonar/bin/hdc -v
```

## 输出解释

版本/设备列表；[Empty]→needs_human。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无设备 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 未 tconn | 修正参数/路径后重试 |
| 可重试失败 | 守护进程 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 hdc | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

install HAP → hilog。

## 证据留存

list targets、命令。标注：真机未验证时写明。

## 版本与限制

钉选 vendor hdc。
