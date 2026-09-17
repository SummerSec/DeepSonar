# ninja

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

执行 CMake/GN 生成的构建。

## 选型依据

不要当源码检索。

## 前置条件

build.ninja。

## 调用方式

`ninja -C build`

最小示例：

```bash
ninja --version
```

## 输出解释

构建成功/失败。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译错误 | 修正参数/路径后重试 |
| 可重试失败 | 偶发 race 可重试 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 未配置 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

接测试二进制。

## 证据留存

目标名与日志尾。

## 版本与限制

审计/fuzz。
