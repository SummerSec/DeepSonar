# build-essential (gcc/make)

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

需要编译 C/C++ PoC 或本地小工具时使用。

## 选型依据

Chrome/ClickHouse 审计优先用镜像内 clang 工具链；不要在 base 镜像假设完整编译链。

## 前置条件

源码与依赖头文件可用。

## 调用方式

入口：`gcc`/`g++`/`make`。

最小示例：

```bash
gcc -O0 -g -o /tmp/poc /tmp/poc.c && /tmp/poc
```

## 输出解释

二进制与运行输出；编译成功≠漏洞确认。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 编译错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 缺库/编译器 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

编译后运行；需要 sanitizer 时改用 clang -fsanitize。

## 证据留存

源码、编译命令、退出码、运行输出。

## 版本与限制

kali/openharmony 等；磁盘与 CPU 占用高。
