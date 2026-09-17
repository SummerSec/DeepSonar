# chromium-headless 能力

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

无界面渲染与自动化。

## 选型依据

同 chromium。

## 前置条件

headless 标志。

## 调用方式

经 chrome-headless.sh。

最小示例：

```bash
/opt/deepsonar/bin/chrome-headless.sh --headless=new --dump-dom about:blank | head
```

## 输出解释

DOM 转储。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空 DOM | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 标志错误 | 修正参数/路径后重试 |
| 可重试失败 | 崩溃 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无显示后端时必须 headless | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 CDP。

## 证据留存

DOM 摘要哈希。

## 版本与限制

同 chromium。
