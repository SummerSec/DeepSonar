# claude / Agent CLI

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

由平台拉起的 Agent CLI 入口（任务会话），不是漏洞扫描器。

## 选型依据

禁止把 CLI 本身当作安全证据来源；分析请用本手册其他工具。

## 前置条件

由 Scheduler/Worker 注入会话与凭据；沙箱内通常已登录策略管控。

## 调用方式

由运行时封装调用；Agent 应优先用 bash/文件工具执行本手册命令。

最小示例：

```bash
command -v claude || command -v node
```

## 输出解释

CLI 可用性不证明目标安全属性。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 无 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | CLI 不在镜像则报 needs_human | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

CLI 编排 → 具体工具手册。

## 证据留存

不要把模型口述当运行证据。

## 版本与限制

与 runtime-images 钉选 CLI 一致。
