# cmake

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

配置 C++ 工程生成构建图。

## 选型依据

纯读代码不需要。

## 前置条件

CMakeLists.txt；依赖齐全。

## 调用方式

`cmake -S . -B build -G Ninja`

最小示例：

```bash
cmake --version
```

## 输出解释

配置日志；失败看缺依赖。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 缺依赖 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 cmake | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

ninja 构建 → 测试/fuzz。

## 证据留存

cmake 命令与 cache 关键项。

## 版本与限制

clickhouse-audit/fuzz、openharmony。
