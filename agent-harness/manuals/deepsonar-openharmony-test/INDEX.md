# deepsonar-openharmony-test 工具说明书索引

> 焦点：构建、hdc 接入、设备操作前提及观察
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
- [python3-requests](tools/python3-requests.md) — `python3-requests`
- [build-essential (gcc/make)](tools/build-essential.md) — `build-essential`
- [ccache](tools/ccache.md) — `ccache`
- [cmake](tools/cmake.md) — `cmake`
- [ninja](tools/ninja.md) — `ninja`
- [hdc + wrappers](tools/hdc.md) — `hdc`
- [openharmony-env.sh](tools/openharmony-env.sh.md) — `openharmony-env.sh`
- [openharmony-hdc.sh](tools/openharmony-hdc.sh.md) — `openharmony-hdc.sh`
- [openharmony-init.sh](tools/openharmony-init.sh.md) — `openharmony-init.sh`
- [openharmony-build.sh](tools/openharmony-build.sh.md) — `openharmony-build.sh`
- [node](tools/node.md) — `node`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

