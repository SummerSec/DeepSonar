/**
 * Operator-facing one-liners for official specialty images.
 * Keys must stay aligned with Scheduler SPECIALTY_RUNTIME_IMAGE_POLICIES (#565).
 * Full matrix: docs/RUNTIME_ROLE_IMAGE_MATRIX.md.
 */

export type RuntimeImageBoundarySummary = {
  readonly toolset: string;
  readonly not_included: string;
};

const OFFICIAL_RUNTIME_IMAGE_BOUNDARIES: Readonly<Record<string, RuntimeImageBoundarySummary>> = Object.freeze({
  "deepsonar-chrome-test": {
    toolset: "钉死 Chromium + CDP（playwright-core）",
    not_included: "第二套浏览器 / Selenium Grid / 桌面 GUI",
  },
  "deepsonar-chrome-audit": {
    toolset: "Clang/LLVM + binutils 源码检查",
    not_included: "固定扫描脚本、Chromium 本体、决策扫描器",
  },
  "deepsonar-chrome-fuzz": {
    toolset: "钉死 V8 d8 + libFuzzer/AFL++",
    not_included: "toy d8、完整 Chrome 浏览器",
  },
  "deepsonar-clickhouse-test": {
    toolset: "钉死官方 ClickHouse LTS server/client/local",
    not_included: "非官方包、DinD、toy SQL harness",
  },
  "deepsonar-clickhouse-audit": {
    toolset: "CMake/Ninja + Clang/LLVM 源码检查",
    not_included: "本镜像 CH server、固定扫描脚本",
  },
  "deepsonar-clickhouse-fuzz": {
    toolset: "官方 clickhouse-local + sanitizer/AFL++",
    not_included: "toy harness 冒充官方 binary",
  },
  "deepsonar-openharmony-test": {
    toolset: "源码同步/构建 + 官方 hdc",
    not_included: "DevEco/完整 SDK；勿把 gdb 当设备协议",
  },
  "deepsonar-openharmony-audit": {
    toolset: "主机 Clang/tidy/cppcheck + Sanitizer",
    not_included: "hdc 设备协议、DevEco、密钥扫描器",
  },
  "deepsonar-openharmony-fuzz": {
    toolset: "主机 libFuzzer/AFL++ + sanitizer",
    not_included: "DevEco、toy harness",
  },
  "deepsonar-mobile": {
    toolset: "Android/iOS/OH：JADX/droidasc/apktool/adb/Frida 等",
    not_included: "MobSF/GUI/Ghidra/IDA/DevEco/MCP；禁止 droidasc --gui",
  },
  "deepsonar-kali-minimal": {
    toolset: "多语言动态测试工具链（JDK/Maven/Python/Go/Rust）",
    not_included: "Kali metapackage、GUI、DinD",
  },
  "deepsonar-audit": {
    toolset: "读仓审计辅助（git/rg/binutils 等）",
    not_included: "SAST/密钥扫描器、专项浏览器/DB/设备协议",
  },
  "deepsonar-base": {
    toolset: "最小通用 CLI / Agent 运行时",
    not_included: "完整语言矩阵、专项协议工具",
  },
});

export function officialRuntimeImageBoundary(imageKey: string | null | undefined): RuntimeImageBoundarySummary | null {
  if (!imageKey) return null;
  return OFFICIAL_RUNTIME_IMAGE_BOUNDARIES[imageKey] ?? null;
}

export function officialRuntimeImageNotIncludedOneLiner(imageKey: string | null | undefined): string | null {
  return officialRuntimeImageBoundary(imageKey)?.not_included ?? null;
}

export function officialRuntimeImageToolsetOneLiner(imageKey: string | null | undefined): string | null {
  return officialRuntimeImageBoundary(imageKey)?.toolset ?? null;
}

/** Specialty keys that Scheduler injects for any role (excludes base/audit/kali). */
export const WEB_SPECIALTY_IMAGE_KEYS = Object.freeze([
  "deepsonar-chrome-test",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-fuzz",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-fuzz",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-mobile",
] as const);
