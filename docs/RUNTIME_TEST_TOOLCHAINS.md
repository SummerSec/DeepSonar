# Runtime-test 工具链与证据边界

> **状态：as-built**。索引：[`README.md`](README.md)。角色×官方镜像权威矩阵见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)（#565）。

DeepSonar 把“读代码找问题”和“启动目标、发送请求、观察实际结果”分成两类工作。`audit` 提供基础工具让 Agent 自行阅读与假设，**不是**“规则匹配通常足够”的固定 SAST 路径；需要 `runtime_test` 的 `test` Job 默认使用受治理的 `deepsonar-kali-minimal`（Kali Test），Job 创建时由 Scheduler 冻结可信 digest。系统 `verify` 全局默认仍是 Base（未绑定 RoleConfig 时使用 Base 系统沙箱）；只有目标确实需要动态复现时，项目级 RoleConfig 才显式选择一个已准入、可信且具备目标工具链的镜像。

## 语言能力矩阵

| 场景 | Java | Python | Go | Rust |
| --- | --- | --- | --- | --- |
| 只读代码、读构建产物、Agent 自选启发式 | `deepsonar-audit`（git / ripgrep / binutils 等基础工具；不预装 SAST/密钥扫描器） | 同左 | 同左 | 同左 |
| `test` 动态 PoC / 小服务 | Kali Test：Temurin JDK 8/11/17 + Maven 3.9.16 | Kali Test：Python 3.10–3.14 + `uv` | Kali Test：Go 编译器与运行时 | Kali Test：`rustc` + `cargo` |
| `verify` 动态复现 | 默认 Base；项目显式覆盖为可信动态镜像 | 同左 | 同左 | 同左 |
| 多服务、数据库、Compose 全家桶 | 默认镜像均不保证；另行设计专项环境 | 同左 | 同左 | 同左 |

Base 刻意不包含 JDK、Maven、Go、Rust 和完整多版本 Python。Kali Test 也不安装 Kali metapackage、GUI 或 Docker-in-Docker；不要把它当成任意目标的完整开发环境。

## Runtime-test 纪律

- 先读取冻结 runtime manifest，按目标语言检查相关预装工具：Java 用 `command -v java`、`java -version`；Maven 项目再用 `command -v mvn`、`mvn -v`（必要时使用 `java8` / `java11` / `java17`）；Python 用目标所需的 `python3.x` / `uv`；Go 用 `command -v go`、`go version`；Rust 用 `command -v rustc`、`rustc --version`、`command -v cargo`、`cargo --version`，并记录镜像 key、digest 和版本。
- 不在 Job 内用 `apt-get`、JDK/Maven 压缩包、SDKMAN、`./mvnw` 或其它 bootstrap fallback 安装或下载工具链。项目依赖是否可下载仍由冻结的 `DEEPSONAR_ALLOW_EGRESS` 决定。
- 工具缺失时停止动态尝试，提交 `inconclusive`/`needs_human` 结构化证据；不得用静态叙述冒充运行时结果。
- OpenHarmony Test 的设备协议是官方 `hdc`（`list targets` / `shell` / `file send|recv` / `install` / `hilog` / `fport` / `tconn`）。无 target 时必须结构化 `needs_human` / `inconclusive`，禁止把主机构建日志或源码叙述写成设备结果。audit/fuzz 仍可使用主机 Clang/ASan/libFuzzer；不要把 gdb/strace 或 Kali 进程工具当成 OH 的设备协议。
- 移动端专项镜像 `deepsonar-mobile`：Android 设备协议是官方 `adb`；iOS Linux 宿主是 `idevice_id` / `ideviceinstaller` / `iproxy`（无 Xcode/Simulator）；OpenHarmony 设备协议是官方 `hdc`（与 OH Test 同一 vendor 二进制），HAP 静态检查用 unzip + `pack.info` / `module.json`。Android 静态检查：Java/Kotlin 用 JADX CLI、apktool、bundletool、apkeep、androguard、钉死的 `droidasc`（Droid ASC：大包按需 `getclass`/`getmanifest`/`findrefs`，与 JADX 互补；禁止 `--gui`），以及 Agent 可调用的钉死 `apkcheckpack`（加固/SDK 指纹，不是平台扫描入口）；`.so` 用 `readelf`/`objdump`/`nm`、radare2 与 LIEF（`mobile-so.sh inspect`）。运行时插桩用 Frida/Objection 与 `/opt/deepsonar/frida-server`。不预装 mitmproxy/Burp。无 adb / hdc / idevice 目标时必须结构化 `needs_human` / `inconclusive`，禁止把 JADX/droidasc 反编译或 HAP/IPA 解压叙述写成设备、流量或原生结果。不预装 MobSF / jadx-gui / Burp / IDA / Ghidra / DevEco / 第三方 MCP。
- 合格计入配对库存的 test 证据至少要有 `subject_revision`、完整 `steps`、`expected`，以及 `actual` 或 `artifact_refs`，且 test 与 review 来自不同 Job 时才算配对完整；该配对在 Fact-first v1 下为 advisory，确认硬门仍只看结构化 supporting Fact。

## 冒烟与真实证据

- `node agent-harness/test-mobile-runtime.mjs` 用假 adb / hdc / idevice_id 与样本 HAP 检查版本冒烟与空设备 `needs_human` / `inconclusive`，不要求真机。
- `node agent-harness/test-runtime-image.mjs <image> kali-minimal agent-harness/kali-minimal-runtime.json` 在断网、丢弃 capabilities 和资源限制下检查预装 Java/Go/Rust/Python/Maven；其中 `mvn -v` 只验证工具存在，不下载依赖。
- `node agent-harness/test-maven-package.mjs <image>` 使用联网最小 POM 构建并运行一个 Java 类，仓库放在临时目录，不写入镜像的 `.m2`。
- `python agent-harness/test-runtime-images-api.py` 检查 Test 默认 Kali、Verify 默认 Base、显式项目级 Verify 动态覆盖和 Job 不可变 snapshot。

这些是运行时能力和配置门禁，不是对 `java-sec-code` 或任何具体漏洞的确认。Scheduler 确认硬门是可版本化的 Fact-first 策略（当前 `fact_first` v1）：合格的结构化 supporting Fact（含 `subject_revision` / ownership / `expected` / `actual` / `outcome=supports`）即可确认；独立 review + runtime_test 配对是动态复现域的 **advisory** 完整度提示，不是所有 profile 的必需门禁，也不得与 `confirmed` 同时宣称「必需证据缺失」。本地冒烟本身永远不会生成 Finding。

运行证明与文本 expected/actual 的边界（#577）：策略若要求 runtime proof，须持久化目标 revision、steps、environment 或 runtime_digest、exit_code，以及带内容摘要的产物引用；仅有文本 expected/actual 不构成已复现证明。内容完整性摘要与 Hub 唤醒用 evidence_signature / gate_fingerprint 分离——修改完整性不得引入重复 Hub 唤醒。确认记录可通过 fact_evidence_trace 按 used_fact_ids（canvas Fact 节点）回放到来源 Job/Attempt 与可复查产物；无生产库样本时不预断言悬空数量。
