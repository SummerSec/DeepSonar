# cargo

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

Rust 项目构建入口。

## 选型依据

单文件可用 rustc。

## 前置条件

Cargo 项目。

## 调用方式

`cargo build`/`test`/`run`。

最小示例：

```bash
cargo --version
```

## 输出解释

构建日志。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 依赖/代码错误 | 修正参数/路径后重试 |
| 可重试失败 | 网络 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 cargo | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 rustc 相同。

## 证据留存

Cargo.lock 哈希。

## 版本与限制

kali。
