# binutils (readelf/objdump/nm)

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

查看 ELF 头、节区、符号、反汇编摘要；native 初筛。

## 选型依据

需要交互式深挖用 r2；Java 层用 jadx/droidasc。

## 前置条件

目标为 ELF/.so。

## 调用方式

入口：`readelf`/`objdump`/`nm`。

最小示例：

```bash
readelf -hW /path/to/lib.so && nm -D /path/to/lib.so | head
```

## 输出解释

ELF 元数据与符号；不能单独证明运行时漏洞。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无动态符号 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 非 ELF | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 工具或文件缺失 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

file → readelf → r2/LIEF；与 Frida 动态验证组合。

## 证据留存

保存命令、SO 哈希、关键节区/符号摘录。

## 版本与限制

audit/mobile/kali 提供；注意剥符号二进制。
