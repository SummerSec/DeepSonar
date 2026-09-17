# chromium + chrome-headless.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

需要真实浏览器页面观察、DOM/网络/截图时使用。

## 选型依据

静态前端代码阅读用 base/audit；不要 apt 再装 Chrome。

## 前置条件

包装脚本；`--no-sandbox`/`--headless=new`；目标 URL 可达或本地文件。

## 调用方式

入口：`/opt/deepsonar/bin/chrome-headless.sh` 与 `chrome-test-env.sh --check`。CDP 端口由包装暴露。

最小示例：

```bash
/opt/deepsonar/bin/chrome-test-env.sh --check && /opt/deepsonar/bin/chrome-headless.sh --version
```

## 输出解释

浏览器版本/CDP 端点；页面内容需经 CDP 客户端。截图可证明渲染，不自动等于 XSS 可利用。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空白页 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 错误 URL/标志 | 修正参数/路径后重试 |
| 可重试失败 | 浏览器偶发崩溃 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 包装或 chromium 缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

CDP 观察 → 保存 HAR/截图 → 必要时用 rg 对照源码。

## 证据留存

启动命令、CDP 端口、URL、截图/日志、镜像 digest。

## 版本与限制

钉选 chromium 见 tool-manifest；清理临时 profile。
