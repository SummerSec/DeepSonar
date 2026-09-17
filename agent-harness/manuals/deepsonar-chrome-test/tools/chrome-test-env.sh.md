# chrome-test-env.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

检查 chrome-test 工具链是否就绪。

## 选型依据

不是页面测试本身。

## 前置条件

镜像为 chrome-test。

## 调用方式

`/opt/deepsonar/bin/chrome-test-env.sh --check`

最小示例：

```bash
/opt/deepsonar/bin/chrome-test-env.sh --check
```

## 输出解释

检查通过打印就绪信息。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 环境变量 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺二进制 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

检查后启动 headless。

## 证据留存

检查日志。

## 版本与限制

随镜像包装脚本。
