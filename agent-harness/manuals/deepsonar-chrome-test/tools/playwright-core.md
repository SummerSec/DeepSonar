# playwright-core

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

作为 CDP 客户端库连接镜像内 chromium。

## 选型依据

禁止下载浏览器二进制；禁止 Puppeteer 另起 Chrome。

## 前置条件

npm 已装 playwright-core；chromium 已起。

## 调用方式

node 脚本 `chromium.connectOverCDP`。

最小示例：

```bash
node -e "console.log(require('playwright-core/package.json').version)"
```

## 输出解释

库版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | API 误用 | 修正参数/路径后重试 |
| 可重试失败 | 连接失败可重试 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未安装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 chrome-headless.sh 组合。

## 证据留存

脚本与结果。

## 版本与限制

钉选见 tool-manifest。
