# deepsonar-kali-minimal 工具说明书索引

> 焦点：多语言环境选择、构建运行、依赖约束与 PoC 流程
>
> 本目录随镜像交付，断网可读。路径：`/opt/deepsonar/manuals/`。
> 先读本索引，再按需打开 `tools/<name>.md`；不要把整本手册塞进 prompt。
>
> 内部 npm/agent 运行时依赖与 Agent 直接使用的工具已区分；下列均为 Agent 面向入口。

## 工具列表

- [git](tools/git.md) — `git`
- [python3](tools/python3.md) — `python3`
- [python (managed multi-version)](tools/python.md) — `python`
- [ca-certificates](tools/ca-certificates.md) — `ca-certificates`
- [curl](tools/curl.md) — `curl`
- [ripgrep (rg)](tools/ripgrep.md) — `ripgrep`
- [jq](tools/jq.md) — `jq`
- [file](tools/file.md) — `file`
- [unzip](tools/unzip.md) — `unzip`
- [xz / unxz](tools/xz-utils.md) — `xz-utils`
- [binutils (readelf/objdump/nm)](tools/binutils.md) — `binutils`
- [build-essential (gcc/make)](tools/build-essential.md) — `build-essential`
- [pkg-config](tools/pkg-config.md) — `pkg-config`
- [go](tools/golang-go.md) — `golang-go`
- [rustc/cargo](tools/rustc.md) — `rustc`
- [cargo](tools/cargo.md) — `cargo`
- [node](tools/node.md) — `node`
- [uv](tools/uv.md) — `uv`
- [mvn](tools/maven.md) — `maven`
- [java/javac (managed JDK)](tools/jdk.md) — `jdk`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

