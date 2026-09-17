# V8/d8 源码与构建产物

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

chrome-fuzz 提供钉选 V8 与 d8。

## 选型依据

不要改名玩具 harness 冒充 d8。

## 前置条件

chrome-fuzz 镜像。

## 调用方式

`/opt/deepsonar/bin/d8`；读 tool-manifest.fuzz。

最小示例：

```bash
/opt/deepsonar/bin/chrome-fuzz-env.sh --check
```

## 输出解释

就绪信息与版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 脚本参数 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 非该镜像 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

d8 复现 JS 崩溃；libFuzzer 目标。

## 证据留存

v8 commit 字段。

## 版本与限制

manifest 钉选 commit。
