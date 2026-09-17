# deepsonar-clickhouse-audit 工具说明书索引

> 焦点：源码、构建及静态分析流程
>
> 本目录随镜像交付，断网可读。路径：`/opt/deepsonar/manuals/`。
> 先读本索引，再按需打开 `tools/<name>.md`；不要把整本手册塞进 prompt。
>
> 内部 npm/agent 运行时依赖与 Agent 直接使用的工具已区分；下列均为 Agent 面向入口。

## 工具列表

- [git](tools/git.md) — `git`
- [git partial clone](tools/git-partial-clone.md) — `git-partial-clone`
- [cmake](tools/cmake.md) — `cmake`
- [ninja](tools/ninja.md) — `ninja`
- [clang/clang++](tools/clang.md) — `clang`
- [clang-tidy](tools/clang-tidy.md) — `clang-tidy`
- [clangd](tools/clangd.md) — `clangd`
- [llvm 工具集](tools/llvm.md) — `llvm`
- [objdump](tools/objdump.md) — `objdump`
- [readelf](tools/readelf.md) — `readelf`
- [llvm-nm](tools/llvm-nm.md) — `llvm-nm`
- [python3](tools/python3.md) — `python3`
- [jq](tools/jq.md) — `jq`
- [clickhouse-audit-env.sh](tools/clickhouse-audit-env.sh.md) — `clickhouse-audit-env.sh`
- [node](tools/node.md) — `node`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

