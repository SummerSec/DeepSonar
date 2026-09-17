# deepsonar-openharmony-audit 工具说明书索引

> 焦点：主机静态分析、工具选择及证据边界
>
> 本目录随镜像交付，断网可读。路径：`/opt/deepsonar/manuals/`。
> 先读本索引，再按需打开 `tools/<name>.md`；不要把整本手册塞进 prompt。
>
> 内部 npm/agent 运行时依赖与 Agent 直接使用的工具已区分；下列均为 Agent 面向入口。

## 工具列表

- [git](tools/git.md) — `git`
- [git-lfs](tools/git-lfs.md) — `git-lfs`
- [repo](tools/repo.md) — `repo`
- [python3](tools/python3.md) — `python3`
- [build-essential (gcc/make)](tools/build-essential.md) — `build-essential`
- [ccache](tools/ccache.md) — `ccache`
- [cmake](tools/cmake.md) — `cmake`
- [ninja](tools/ninja.md) — `ninja`
- [clang/clang++](tools/clang.md) — `clang`
- [clang-tidy](tools/clang-tidy.md) — `clang-tidy`
- [scan-build](tools/scan-build.md) — `scan-build`
- [llvm-symbolizer](tools/llvm-symbolizer.md) — `llvm-symbolizer`
- [compiler-rt](tools/compiler-rt.md) — `compiler-rt`
- [gdb](tools/gdb.md) — `gdb`
- [objdump](tools/objdump.md) — `objdump`
- [addr2line](tools/addr2line.md) — `addr2line`
- [sparse](tools/sparse.md) — `sparse`
- [cppcheck](tools/cppcheck.md) — `cppcheck`
- [bear](tools/bear.md) — `bear`
- [libasan](tools/libasan.md) — `libasan`
- [libubsan](tools/libubsan.md) — `libubsan`
- [openharmony-audit-env.sh](tools/openharmony-audit-env.sh.md) — `openharmony-audit-env.sh`
- [openharmony-audit-scan.sh](tools/openharmony-audit-scan.sh.md) — `openharmony-audit-scan.sh`
- [node](tools/node.md) — `node`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

