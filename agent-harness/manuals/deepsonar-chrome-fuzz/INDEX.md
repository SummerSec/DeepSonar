# deepsonar-chrome-fuzz 工具说明书索引

> 焦点：d8、fuzz harness、种子、sanitizer 与崩溃复现
>
> 本目录随镜像交付，断网可读。路径：`/opt/deepsonar/manuals/`。
> 先读本索引，再按需打开 `tools/<name>.md`；不要把整本手册塞进 prompt。
>
> 内部 npm/agent 运行时依赖与 Agent 直接使用的工具已区分；下列均为 Agent 面向入口。

## 工具列表

- [clang-16](tools/clang-16.md) — `clang-16`
- [clang++-16](tools/clang++-16.md) — `clang++-16`
- [lld-16](tools/lld-16.md) — `lld-16`
- [llvm-16](tools/llvm-16.md) — `llvm-16`
- [compiler-rt](tools/compiler-rt.md) — `compiler-rt`
- [libFuzzer](tools/libFuzzer-16.md) — `libFuzzer-16`
- [AFL++](tools/AFL++.md) — `AFL++`
- [binutils (readelf/objdump/nm)](tools/binutils.md) — `binutils`
- [V8/d8 源码与构建产物](tools/v8-source.md) — `v8-source`
- [d8](tools/d8.md) — `d8`
- [v8_json_libfuzzer](tools/v8_json_libfuzzer.md) — `v8_json_libfuzzer`
- [chrome-fuzz-env.sh](tools/chrome-fuzz-env.sh.md) — `chrome-fuzz-env.sh`
- [node](tools/node.md) — `node`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

