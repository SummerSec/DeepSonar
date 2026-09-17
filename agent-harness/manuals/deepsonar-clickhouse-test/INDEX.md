# deepsonar-clickhouse-test 工具说明书索引

> 焦点：local/client/server 选型、SQL 执行与结果解释
>
> 本目录随镜像交付，断网可读。路径：`/opt/deepsonar/manuals/`。
> 先读本索引，再按需打开 `tools/<name>.md`；不要把整本手册塞进 prompt。
>
> 内部 npm/agent 运行时依赖与 Agent 直接使用的工具已区分；下列均为 Agent 面向入口。

## 工具列表

- [git](tools/git.md) — `git`
- [clickhouse 官方二进制](tools/clickhouse.md) — `clickhouse`
- [clickhouse-client](tools/clickhouse-client.md) — `clickhouse-client`
- [clickhouse-local](tools/clickhouse-local.md) — `clickhouse-local`
- [clickhouse-server.sh](tools/clickhouse-server.md) — `clickhouse-server`
- [ClickHouse HTTP 接口](tools/clickhouse-http.md) — `clickhouse-http`
- [clickhouse-test-env.sh](tools/clickhouse-test-env.sh.md) — `clickhouse-test-env.sh`
- [node](tools/node.md) — `node`
- [claude / Agent CLI](tools/claude.md) — `claude`

## 阅读要求

1. 选型先看「使用场景/选型依据」，再调用。
2. 失败分类不得一律 `needs_human`。
3. 缺设备/缺服务时写明未验证，禁止编造运行结果。
4. 证据保留命令、修订、日志与产物哈希。

