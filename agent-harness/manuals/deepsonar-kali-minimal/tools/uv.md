# uv

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

创建 venv、安装 Python 依赖、选择 Python 版本（kali）。

## 选型依据

系统已有模块直接 python3；移动端专用 venv 已预装 frida 等。

## 前置条件

允许写 venv 目录；egress 策略。

## 调用方式

`uv venv`/`uv pip install`/`uv python`。

最小示例：

```bash
uv --version
```

## 输出解释

工具版本与 venv 路径。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 错误 Python 版本 | 修正参数/路径后重试 |
| 可重试失败 | PyPI 瞬时 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 断网 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

venv 后跑 pytest/PoC。

## 证据留存

锁文件与版本。

## 版本与限制

kali/mobile 钉选。
