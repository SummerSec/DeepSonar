/**
 * Hub-facing runtime image capability catalog (#565).
 *
 * list_available_runtime_images merges these fields into each catalog entry so
 * Hub can match task needs → image_key (never guess keys from memory).
 * Keep in sync with docs/RUNTIME_ROLE_IMAGE_MATRIX.md and Worker specialty
 * policies in domains/role-runtime-snapshot/runtime-image-boundary-policy.ts.
 */

import { agentCliIdsCompatibleWithImage } from "@deepsonar/runtime-sandbox";
import type { RuntimeImageReadiness, RuntimeImageReadinessView } from "./runtime-image-readiness.js";

export type HubRuntimeImageCapability = {
  /** What this image is for (Hub matching). */
  purpose: string;
  /** Preinstalled tools / protocols summary. */
  tool_summary: string;
  /** Explicit NOT included. */
  not_included: string;
  /** Roles that typically use this image. */
  suited_roles: string[];
  /** Evidence / work kinds this image supports. */
  suited_evidence: string[];
  /** Task→image selection hints for Hub. */
  selection_hints: string[];
  /** Machine-ish capability tags for matching. */
  capabilities: string[];
};

/** Hub 本轮可提案的运行镜像目录条目；只含决策摘要，不含可执行 OCI 引用或 digest。 */
export interface HubRuntimeImageCatalogEntry extends HubRuntimeImageCapability {
  image_key: string;
  name: string;
  description: string;
  official: boolean;
  project_opt_in: boolean;
  source_kind: string;
  compatible_agent_clis: string[];
  readiness: RuntimeImageReadiness;
  preparing: boolean;
  error_code: string | null;
  error: string | null;
  checked_at: string;
  task_id: string | null;
}

const UNKNOWN_CAPABILITY: HubRuntimeImageCapability = Object.freeze({
  purpose: "未在官方能力表登记的镜像；勿假设预装专项工具",
  tool_summary: "以镜像 description 与 Job 内 tool-manifest 为准",
  not_included: "未登记专项能力；禁止凭记忆假设 Chrome/ClickHouse/移动端/OH 工具",
  suited_roles: [],
  suited_evidence: [],
  selection_hints: ["仅当任务明确要求该 image_key 且角色 CLI 兼容时提案；否则省略字段走角色缺省"],
  capabilities: [],
});

const OFFICIAL_HUB_IMAGE_CAPABILITIES: Readonly<Record<string, HubRuntimeImageCapability>> = Object.freeze({
  "deepsonar-base": {
    purpose: "最小通用 Agent 运行时：探索/分析/复核/代码/Hub/Verify/报告缺省底座",
    tool_summary: "Node 22 + 受治理通用 CLI 能力（text.search.rg / json.query.jq / source.control.git / file.inspect.file / evidence.hash.sha256sum / execution.timeout / archive.extract 等）",
    not_included: "完整 JDK/Maven/Go/Rust 矩阵、专项浏览器/DB/设备协议、Kali metapackage；fd/yq/diff/patch 本阶段目录已登记但镜像未钉死",
    suited_roles: ["explore", "analyze", "review", "code", "hub_reason", "verify", "report"],
    suited_evidence: ["只读事实", "轻量分析", "缺省 verify"],
    selection_hints: ["无专项工具需求时省略 runtime_image_key", "不要为动态 PoC/APK/CDP/ClickHouse 选 base", "通用 CLI 通过 list_capabilities 选 cli 能力 id，勿猜测未登记命令"],
    capabilities: ["base-cli", "agent-runtime", "text.search.rg", "json.query.jq", "source.control.git", "file.inspect.file", "evidence.hash.sha256sum", "execution.timeout", "archive.extract"],
  },
  "deepsonar-audit": {
    purpose: "通用代码审计：读仓与 Agent 自选启发式，产出 Finding",
    tool_summary: "Base 受治理 CLI 能力 + binutils 等审计辅助；不预装决策型 SAST/密钥扫描器",
    not_included: "Semgrep/gitleaks/shellcheck 决策扫描器、Chromium/ClickHouse/adb/hdc；fd/yq/diff/patch 本阶段未钉死",
    suited_roles: ["audit"],
    suited_evidence: ["静态审计 Finding", "源码阅读"],
    selection_hints: ["通用源码审计选 audit", "Chrome/C++ 专项审计选 chrome-audit；移动端选 mobile", "CLI 能力 id 见 list_capabilities（#611）"],
    capabilities: ["source-audit", "binutils", "text.search.rg", "json.query.jq", "source.control.git", "file.inspect.file", "evidence.hash.sha256sum", "execution.timeout", "archive.extract"],
  },
  "deepsonar-kali-minimal": {
    purpose: "动态测试 / PoC：多语言编译运行时（Test 默认）",
    tool_summary: "Temurin JDK 8/11/17 + Maven 3.9.16、Python 3.10–3.14+uv、Go、Rust",
    not_included: "Kali metapackage/GUI、Docker-in-Docker、完整 DB/Compose 全家桶",
    suited_roles: ["test", "verify"],
    suited_evidence: ["runtime_test", "PoC", "多语言动态复现"],
    selection_hints: ["需要编译/跑 Java/Python/Go/Rust PoC 选 kali-minimal", "浏览器 CDP 选 chrome-test；ClickHouse 选 clickhouse-test；APK 选 mobile"],
    capabilities: ["java", "maven", "python", "go", "rust", "runtime-test"],
  },
  "deepsonar-chrome-test": {
    purpose: "浏览器动态证据：钉死 Chromium + CDP",
    tool_summary: "Chromium headless + playwright-core connectOverCDP + chrome-headless.sh",
    not_included: "第二套浏览器、Selenium Grid、完整 Playwright browsers、桌面 GUI",
    suited_roles: ["test", "verify", "explore"],
    suited_evidence: ["CDP", "DOM/网络观察", "headless 浏览器复现"],
    selection_hints: ["任务需要 Chromium/CDP/页面动态行为 → chrome-test", "不要猜 chrome 或随意 image_key"],
    capabilities: ["chromium", "cdp", "headless-browser"],
  },
  "deepsonar-chrome-audit": {
    purpose: "Chrome/C++ 源码审计工具链（无固定扫描脚本）",
    tool_summary: "git + Clang/LLVM + clang-tidy/clangd + binutils",
    not_included: "固定扫描规则包、Chromium 浏览器本体、决策扫描器",
    suited_roles: ["audit", "analyze"],
    suited_evidence: ["C++ 静态检查", "Chrome 源码阅读"],
    selection_hints: ["审计 Chromium/C++ 树选 chrome-audit", "需要跑浏览器选 chrome-test", "需要 C/C++ 符号导航时提案 language-server.clangd（需 compile_commands.json）"],
    capabilities: ["cpp-toolchain", "clang", "source-inspection", "language-server.clangd"],
  },
  "deepsonar-chrome-fuzz": {
    purpose: "V8/Chrome 模糊测试：钉死 d8 + sanitizer/libFuzzer",
    tool_summary: "钉死 V8 d8、v8_json_libfuzzer、Clang/LLVM sanitizer、AFL++",
    not_included: "toy d8、第二套 V8、完整 Chrome 浏览器",
    suited_roles: ["test"],
    suited_evidence: ["fuzz crash", "d8 复现"],
    selection_hints: ["需要 V8 d8/libFuzzer → chrome-fuzz"],
    capabilities: ["v8", "d8", "libfuzzer", "afl", "sanitizer"],
  },
  "deepsonar-clickhouse-test": {
    purpose: "ClickHouse 动态证据：钉死官方 LTS server/client/local",
    tool_summary: "官方 clickhouse / clickhouse-client / clickhouse-local / clickhouse-server 包装",
    not_included: "apt/非官方包、DinD、toy SQL harness",
    suited_roles: ["test", "verify"],
    suited_evidence: ["SQL 动态复现", "ClickHouse 服务行为"],
    selection_hints: ["需要官方 ClickHouse 进程/SQL → clickhouse-test"],
    capabilities: ["clickhouse", "sql", "clickhouse-local", "clickhouse-server"],
  },
  "deepsonar-clickhouse-audit": {
    purpose: "ClickHouse/C++ 源码审计工具链",
    tool_summary: "git + CMake/Ninja + Clang/LLVM + binutils",
    not_included: "本镜像内 CH server、固定扫描脚本、决策扫描器",
    suited_roles: ["audit", "analyze"],
    suited_evidence: ["ClickHouse C++ 静态检查"],
    selection_hints: ["审计 ClickHouse 源码选 clickhouse-audit；跑官方 binary 选 clickhouse-test", "需要 C/C++ 符号导航时提案 language-server.clangd（需 compile_commands.json）"],
    capabilities: ["cpp-toolchain", "cmake", "clickhouse-source", "language-server.clangd"],
  },
  "deepsonar-clickhouse-fuzz": {
    purpose: "ClickHouse 模糊/sanitizer：官方 clickhouse-local + fuzz 工具链",
    tool_summary: "官方 clickhouse-local + Clang sanitizer + AFL++/libFuzzer",
    not_included: "toy harness 冒充官方 binary",
    suited_roles: ["test"],
    suited_evidence: ["fuzz crash", "sanitizer 复现"],
    selection_hints: ["ClickHouse fuzz/sanitizer → clickhouse-fuzz"],
    capabilities: ["clickhouse-local", "libfuzzer", "afl", "sanitizer"],
  },
  "deepsonar-openharmony-test": {
    purpose: "OpenHarmony 构建 + 官方 hdc 设备协议",
    tool_summary: "源码同步/构建工具 + 钉死官方 hdc（list targets/shell/file/install/hilog/fport/tconn）",
    not_included: "DevEco/完整 SDK；勿把 gdb/strace 当设备协议",
    suited_roles: ["test", "verify"],
    suited_evidence: ["hdc 设备证据", "OH 构建/安装"],
    selection_hints: ["需要 hdc 真机/模拟设备证据 → openharmony-test", "仅主机静态分析 → openharmony-audit"],
    capabilities: ["hdc", "openharmony", "device-protocol"],
  },
  "deepsonar-openharmony-audit": {
    purpose: "OpenHarmony 主机静态审计（Clang/sanitizer 工具链）",
    tool_summary: "Clang/clang-tidy/cppcheck/sparse + ASan/UBSan 构建支持",
    not_included: "hdc 设备协议、DevEco、密钥扫描器",
    suited_roles: ["audit"],
    suited_evidence: ["OH 主机静态分析", "内存安全假设"],
    selection_hints: ["OH 源码静态审计 → openharmony-audit；设备 I/O → openharmony-test"],
    capabilities: ["clang", "asan", "openharmony-host-audit"],
  },
  "deepsonar-openharmony-fuzz": {
    purpose: "OpenHarmony 主机 fuzz（libFuzzer/AFL++）",
    tool_summary: "主机 libFuzzer/AFL++ + sanitizer 构建",
    not_included: "DevEco、toy harness、hdc 设备协议",
    suited_roles: ["test"],
    suited_evidence: ["host fuzz crash"],
    selection_hints: ["OH 主机 fuzz → openharmony-fuzz"],
    capabilities: ["libfuzzer", "afl", "openharmony-host-fuzz"],
  },
  "deepsonar-mobile": {
    purpose: "移动端审计/测试：Android / iOS 宿主 / OpenHarmony HAP+hdc",
    tool_summary: "Android JADX/apktool/androguard/droidasc/apkcheckpack/adb/Frida；iOS idevice*；OH HAP/hdc；native .so radare2/LIEF",
    not_included: "MobSF/jadx-gui/Burp/IDA/Ghidra/DevEco/第三方 MCP/mitmproxy；禁止 droidasc --gui",
    suited_roles: ["audit", "test", "verify", "explore"],
    suited_evidence: ["APK/AAB 静态", "adb/Frida 动态", "IPA/HAP", "mobile native"],
    selection_hints: [
      "APK/AAB/移动端包或 adb/Frida → mobile",
      "大包按需 class/xref 用 droidasc；完整反编译用 JADX；勿用 ASC 叙述冒充设备/流量",
      "纯 OH 设备协议也可选 openharmony-test；通用源码审计不要用 mobile",
    ],
    capabilities: ["apk", "adb", "frida", "ios-host", "hdc", "mobile-native", "apk-xref-search"],
  },
});

export function hubRuntimeImageCapability(imageKey: string): HubRuntimeImageCapability {
  return OFFICIAL_HUB_IMAGE_CAPABILITIES[imageKey] ?? UNKNOWN_CAPABILITY;
}

export function officialHubRuntimeImageCapabilityKeys(): string[] {
  return Object.keys(OFFICIAL_HUB_IMAGE_CAPABILITIES);
}

function defaultHubRuntimeImageReadiness(): RuntimeImageReadinessView {
  return {
    readiness: "ready",
    preparing: false,
    error_code: null,
    error: null,
    checked_at: new Date().toISOString(),
    task_id: null,
  };
}

/** 目录条目：无治理 CLI 能跑的 key（例如第三方尚未进适配器 allowlist）对 Hub 不可见。 */
export function toHubRuntimeImageCatalogEntry(row: Record<string, unknown>): HubRuntimeImageCatalogEntry | null {
  const image_key = String(row.image_key);
  const compatible_agent_clis = agentCliIdsCompatibleWithImage(image_key);
  if (compatible_agent_clis.length === 0) return null;
  const capability = hubRuntimeImageCapability(image_key);
  return {
    image_key,
    name: String(row.name),
    description: String(row.description ?? ""),
    official: row.official === true,
    project_opt_in: row.project_opt_in === true,
    source_kind: String(row.source_kind),
    compatible_agent_clis,
    ...capability,
    ...defaultHubRuntimeImageReadiness(),
  };
}
