# Runtime-test 工具链与证据边界

> **状态：as-built**。索引：[`README.md`](README.md)。

DeepSonar 把“读代码找问题”和“启动目标、发送请求、观察实际结果”分成两类工作。`audit` 主要负责静态审计；需要 `runtime_test` 的 `test` Job 默认使用受治理的 `deepsonar-kali-minimal`（Kali Test），Job 创建时由 Scheduler 冻结可信 digest。系统 `verify` 全局默认仍是 Base（未绑定 RoleConfig 时使用 Base 系统沙箱）；只有目标确实需要动态复现时，项目级 RoleConfig 才显式选择一个已准入、可信且具备目标工具链的镜像。

## 语言能力矩阵

| 场景 | Java | Python | Go | Rust |
| --- | --- | --- | --- | --- |
| 只读代码、规则匹配、静态 Finding | `deepsonar-audit` 通常足够 | `deepsonar-audit` 通常足够 | `deepsonar-audit` 通常足够 | `deepsonar-audit` 通常足够 |
| `test` 动态 PoC / 小服务 | Kali Test：Temurin JDK 8/11/17 + Maven 3.9.16 | Kali Test：Python 3.10–3.14 + `uv` | Kali Test：Go 编译器与运行时 | Kali Test：`rustc` + `cargo` |
| `verify` 动态复现 | 默认 Base；项目显式覆盖为可信动态镜像 | 同左 | 同左 | 同左 |
| 多服务、数据库、Compose 全家桶 | 默认镜像均不保证；另行设计专项环境 | 同左 | 同左 | 同左 |

Base 刻意不包含 JDK、Maven、Go、Rust 和完整多版本 Python。Kali Test 也不安装 Kali metapackage、GUI 或 Docker-in-Docker；不要把它当成任意目标的完整开发环境。

## Runtime-test 纪律

- 先读取冻结 runtime manifest，按目标语言检查相关预装工具：Java 用 `command -v java`、`java -version`；Maven 项目再用 `command -v mvn`、`mvn -v`（必要时使用 `java8` / `java11` / `java17`）；Python 用目标所需的 `python3.x` / `uv`；Go 用 `command -v go`、`go version`；Rust 用 `command -v rustc`、`rustc --version`、`command -v cargo`、`cargo --version`，并记录镜像 key、digest 和版本。
- 不在 Job 内用 `apt-get`、JDK/Maven 压缩包、SDKMAN、`./mvnw` 或其它 bootstrap fallback 安装或下载工具链。项目依赖是否可下载仍由冻结的 `DEEPSONAR_ALLOW_EGRESS` 决定。
- 工具缺失时停止动态尝试，提交 `inconclusive`/`needs_human` 结构化证据；不得用静态叙述冒充运行时结果。
- OpenHarmony Test 的设备协议是官方 `hdc`（`list targets` / `shell` / `file send|recv` / `install` / `hilog` / `fport` / `tconn`）。无 target 时必须结构化 `needs_human` / `inconclusive`，禁止把主机构建日志或源码叙述写成设备结果。audit/fuzz 仍可使用主机 Clang/ASan/libFuzzer；不要把 gdb/strace 或 Kali 进程工具当成 OH 的设备协议。
- 合格的 test 证据至少要有 `subject_revision`、完整 `steps`、`expected`，以及 `actual` 或 `artifact_refs`，且 test 与 review 必须来自不同 Job。

## 冒烟与真实证据

- `node agent-harness/test-runtime-image.mjs <image> kali-minimal agent-harness/kali-minimal-runtime.json` 在断网、丢弃 capabilities 和资源限制下检查预装 Java/Go/Rust/Python/Maven；其中 `mvn -v` 只验证工具存在，不下载依赖。
- `node agent-harness/test-maven-package.mjs <image>` 使用联网最小 POM 构建并运行一个 Java 类，仓库放在临时目录，不写入镜像的 `.m2`。
- `python agent-harness/test-runtime-images-api.py` 检查 Test 默认 Kali、Verify 默认 Base、显式项目级 Verify 动态覆盖和 Job 不可变 snapshot。

这些是运行时能力和配置门禁，不是对 `java-sec-code` 或任何具体漏洞的确认。只有真实目标版本、独立 review、可复查的 runtime_test 输出和 Scheduler 证据硬门全部满足时，Verify 才可能进入 `confirmed`；本地冒烟本身永远不会生成 Finding。
