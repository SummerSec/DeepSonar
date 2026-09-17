# python3-requests

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

OpenHarmony 脚本或简单 HTTP（若策略允许）。

## 选型依据

设备操作必须用 hdc。

## 前置条件

模块已装。

## 调用方式

`python3 -c "import requests"`

最小示例：

```bash
python3 -c "import requests; print(requests.__version__)"
```

## 输出解释

版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 导入失败 | 修正参数/路径后重试 |
| 可重试失败 | 网络 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装/断网 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

辅助下载；不替代 hdc。

## 证据留存

版本与脚本。

## 版本与限制

OH test。
