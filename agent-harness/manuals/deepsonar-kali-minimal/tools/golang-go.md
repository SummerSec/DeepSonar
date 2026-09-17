# go

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

编译/运行 Go PoC 或测试。

## 选型依据

静态阅读可用 rg；不要在 base 假设有 go。

## 前置条件

模块路径或 GOPATH；egress 策略影响 `go mod`。

## 调用方式

`go build`/`go test`/`go run`。

最小示例：

```bash
go version && go env GOVERSION
```

## 输出解释

版本与构建产物。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 语法/模块错误 | 修正参数/路径后重试 |
| 可重试失败 | 代理瞬时失败 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 禁止拉取模块 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

构建后运行二进制；证据写入 verification。

## 证据留存

go.mod、命令、版本。

## 版本与限制

kali 钉选。
