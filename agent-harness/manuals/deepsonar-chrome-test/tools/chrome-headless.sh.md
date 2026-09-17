# chrome-headless.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

统一启动 chromium 的包装入口。

## 选型依据

不要直接裸调用随意路径的 chrome。

## 前置条件

同 chromium。

## 调用方式

`/opt/deepsonar/bin/chrome-headless.sh [chromium args…]`

最小示例：

```bash
/opt/deepsonar/bin/chrome-headless.sh --version
```

## 输出解释

浏览器版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 非法参数 | 修正参数/路径后重试 |
| 可重试失败 | 崩溃 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺包装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 CDP。

## 证据留存

完整 argv。

## 版本与限制

deploy/chrome-headless.sh。
