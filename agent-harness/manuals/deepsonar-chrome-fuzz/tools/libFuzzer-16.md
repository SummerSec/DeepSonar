# libFuzzer

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

进程内 fuzz 驱动。

## 选型依据

无 harness 不要伪装。

## 前置条件

LLVMFuzzerTestOneInput；corpus 目录。

## 调用方式

`./target -runs=100 corpus/`

最小示例：

```bash
test -x /opt/deepsonar/bin/v8_json_libfuzzer && /opt/deepsonar/bin/v8_json_libfuzzer -runs=10 /tmp/corpus || echo "check manifest fuzz.target"
```

## 输出解释

crash/slow 输入；exit 非0 可能发现崩溃。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无崩溃（正常） | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | harness 错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 目标未构建 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

crash → 最小化 → d8/clickhouse-local 复现。

## 证据留存

crash 文件、命令、栈、commit。

## 版本与限制

见 fuzz.actual 字段。
