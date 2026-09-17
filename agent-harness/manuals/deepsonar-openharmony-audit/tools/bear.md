# bear

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

生成 compile_commands.json。

## 选型依据

已有编译数据库则不必。

## 前置条件

可构建。

## 调用方式

`bear -- ninja …`

最小示例：

```bash
bear --version || true
```

## 输出解释

compile_commands.json。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空库 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 构建失败 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未装 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

clang-tidy -p。

## 证据留存

json 哈希。

## 版本与限制

OH audit。
