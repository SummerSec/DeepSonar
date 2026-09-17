# CDP remote debugging

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

通过 Chrome DevTools Protocol 连接已启动浏览器。

## 选型依据

不要用虚构 DOM；断连时 needs_human。

## 前置条件

浏览器以调试端口启动。

## 调用方式

playwright-core connectOverCDP 或 CDP WebSocket。

最小示例：

```bash
node /opt/deepsonar/chrome-test-smoke.mjs
```

## 输出解释

smoke 成功表示 CDP 可用。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无目标 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 端口错误 | 修正参数/路径后重试 |
| 可重试失败 | 瞬时断开 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 浏览器未起 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

观察网络/DOM/console。

## 证据留存

CDP URL、smoke 日志。

## 版本与限制

协议随 chromium。
