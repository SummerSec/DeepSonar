# compiler-rt

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

提供 ASan/UBSan/libFuzzer 运行时。

## 选型依据

不要单独当扫描器。

## 前置条件

fuzz/OH fuzz。

## 调用方式

编译加 `-fsanitize=address,undefined,fuzzer`。

最小示例：

```bash
echo "int LLVMFuzzerTestOneInput(const uint8_t*d,size_t n){return 0;}" >/tmp/f.c; clang-16 -fsanitize=fuzzer -o /tmp/f /tmp/f.c 2>/dev/null || clang -fsanitize=fuzzer -o /tmp/f /tmp/f.c
```

## 输出解释

fuzz 二进制。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 缺 rt | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 compiler-rt | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

跑 corpus。

## 证据留存

sanitize 标志与崩溃栈。

## 版本与限制

随镜像。
