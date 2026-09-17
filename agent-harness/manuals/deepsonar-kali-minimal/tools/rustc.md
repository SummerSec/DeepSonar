# rustc/cargo

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

编译/运行 Rust PoC。

## 选型依据

同 Go；base 无 Rust。

## 前置条件

Cargo.toml 或单文件；egress 影响 crates。

## 调用方式

`rustc`/`cargo build`/`cargo run`。

最小示例：

```bash
rustc --version && cargo --version
```

## 输出解释

版本与产物。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译错误 | 修正参数/路径后重试 |
| 可重试失败 | crates.io 瞬时 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无工具链或断网 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

运行目标二进制。

## 证据留存

版本与命令。

## 版本与限制

kali。
