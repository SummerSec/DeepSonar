# python (managed multi-version)

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

kali 中需要特定 Python 次版本时使用。

## 选型依据

base 仅系统 python3。

## 前置条件

版本已由镜像 managed 提供。

## 调用方式

`python3.x` 或 uv 选择。

最小示例：

```bash
python3 --version
```

## 输出解释

版本。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 版本不存在 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未安装该次版本 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接 uv venv。

## 证据留存

版本字符串。

## 版本与限制

kali managed。
