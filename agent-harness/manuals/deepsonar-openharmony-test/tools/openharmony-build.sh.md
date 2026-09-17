# openharmony-build.sh

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

触发 OH 主机构建。

## 选型依据

设备验证用 hdc。

## 前置条件

源码已 sync。

## 调用方式

`/opt/deepsonar/bin/openharmony-build.sh`

最小示例：

```bash
/opt/deepsonar/bin/openharmony-env.sh --check
```

## 输出解释

构建日志/产物。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 缺依赖 | 修正参数/路径后重试 |
| 可重试失败 | 偶发 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 源码未准备 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

产物 → 测试/hdc install。

## 证据留存

构建命令与产物路径。

## 版本与限制

包装。
