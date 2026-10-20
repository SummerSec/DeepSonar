#!/usr/bin/env bash
# droidasc 兼容入口：默认执行钉死的 rust_ASC（CLI-only 源码构建），不在 Rust 失败时回退。
# Python Droid ASC 只能通过显式回退入口 droidasc-python 调用。
# 兼容策略：仅把旧参数 --threads N / --threads=N 改名为 --thread N / --thread=N，位置保持不变；
# 帮助（-h/--help/help）在 Rust 以退出码 1 输出帮助文本时规范为 stdout + 退出码 0；
# APK 预检：rust_ASC 0.1.1 的 findrefs 对不存在或损坏（无 ZIP EOCD）的 APK 也返回 0 且无输出，
# 与“正常无匹配”无法区分；本入口在执行前检查 APK 是否为可读的 ZIP，否则以退出码 1 明确失败。
# 其他退出码、stdout/stderr 原样透传。每次调用向 stderr 写一行实现/版本/参数记录。
set -euo pipefail

rust_asc_home="${RUST_ASC_HOME:-/opt/deepsonar/rust-asc}"
rust_asc_bin="${RUST_ASC_BIN:-${rust_asc_home}/rust_ASC}"
rust_asc_buildinfo="${RUST_ASC_BUILDINFO:-${rust_asc_home}/BUILDINFO}"

if [[ ! -x "$rust_asc_bin" ]]; then
  printf 'droidasc: rust_ASC 未安装：缺少 %s（不会静默回退到 Python；如需 Python ASC 请显式调用 droidasc-python）\n' "$rust_asc_bin" >&2
  exit 127
fi
if [[ ! -s "$rust_asc_buildinfo" ]]; then
  printf 'droidasc: 缺少 rust_ASC 构建记录 %s\n' "$rust_asc_buildinfo" >&2
  exit 127
fi

buildinfo_value() {
  local key="$1" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$rust_asc_buildinfo"
  return 1
}

if [[ $# -eq 1 && "$1" == "--impl-info" ]]; then
  printf 'entry=droidasc\n'
  cat "$rust_asc_buildinfo"
  exit 0
fi

impl_version="$(buildinfo_value version || true)"
impl_commit="$(buildinfo_value commit || true)"
if [[ -z "$impl_version" || -z "$impl_commit" ]]; then
  printf 'droidasc: rust_ASC 构建记录缺少 version/commit：%s\n' "$rust_asc_buildinfo" >&2
  exit 127
fi

translated=()
renamed=0
help_requested=0
after_separator=0
for arg in "$@"; do
  if (( after_separator )); then
    translated+=("$arg")
    continue
  fi
  case "$arg" in
    --)
      after_separator=1
      translated+=("$arg")
      ;;
    --gui|--gui=*|--gui-foreground)
      printf 'droidasc: GUI 模式在 DeepSonar 镜像中不可用（rust_ASC 为 CLI-only）\n' >&2
      exit 2
      ;;
    --threads)
      translated+=("--thread")
      renamed=1
      ;;
    --threads=*)
      translated+=("--thread=${arg#--threads=}")
      renamed=1
      ;;
    -h|--help)
      help_requested=1
      translated+=("$arg")
      ;;
    *)
      translated+=("$arg")
      ;;
  esac
done
if [[ "${translated[0]:-}" == "help" ]]; then
  help_requested=1
fi

# 定位子命令后的第一个位置参数（APK 路径）；无法确定时交给 rust_ASC 自身报错。
apk_path=""
subcommand=""
expect_value=0
for ((i = 0; i < ${#translated[@]}; i++)); do
  arg="${translated[$i]}"
  if [[ -z "$subcommand" ]]; then
    [[ "$arg" == -* ]] && continue
    subcommand="$arg"
    continue
  fi
  if (( expect_value )); then
    expect_value=0
    continue
  fi
  case "$arg" in
    --)
      apk_path="${translated[$((i + 1))]:-}"
      break
      ;;
    --thread|-o|--output|--prefix|--class)
      expect_value=1
      ;;
    -*)
      ;;
    *)
      apk_path="$arg"
      break
      ;;
  esac
done

if (( help_requested == 0 )) && [[ -n "$apk_path" ]]; then
  case "$subcommand" in
    getclass|listclass|export|getmanifest|findrefs)
      if [[ ! -e "$apk_path" ]]; then
        printf 'droidasc: implementation=rust_ASC preflight=failed\nError: cannot open APK: %s: No such file or directory\n' "$apk_path" >&2
        exit 1
      fi
      if [[ ! -f "$apk_path" || ! -r "$apk_path" ]]; then
        printf 'droidasc: implementation=rust_ASC preflight=failed\nError: APK is not a readable regular file: %s\n' "$apk_path" >&2
        exit 1
      fi
      eocd_count="$(tail -c 65558 -- "$apk_path" | LC_ALL=C grep -caF $'PK\x05\x06' || true)"
      if [[ "${eocd_count:-0}" == "0" ]]; then
        printf 'droidasc: implementation=rust_ASC preflight=failed\nError: APK is not a ZIP archive (EOCD not found): %s\n' "$apk_path" >&2
        exit 1
      fi
      ;;
  esac
fi

printf 'droidasc: implementation=rust_ASC version=%s commit=%s renamed_threads=%s argv=' "$impl_version" "${impl_commit:0:12}" "$renamed" >&2
if (( ${#translated[@]} > 0 )); then
  printf '%q ' "${translated[@]}" >&2
fi
printf '\n' >&2

if (( help_requested == 0 )); then
  exec "$rust_asc_bin" "${translated[@]}"
fi

help_err="$(mktemp)"
trap 'rm -f "$help_err"' EXIT
status=0
"$rust_asc_bin" "${translated[@]}" 2>"$help_err" || status=$?
# clap 的帮助经上游 main 以 "Error: <help>" 写到 stderr 且退出码为 1；真正的参数错误含 "error:" 行。
if [[ "$status" -eq 1 ]] && grep -q '^Usage: ' "$help_err" && ! grep -q 'error:' "$help_err"; then
  sed '1s/^Error: //' "$help_err"
  exit 0
fi
cat "$help_err" >&2
exit "$status"
