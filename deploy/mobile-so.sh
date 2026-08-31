#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：mobile-so.sh --check | inspect <file.so>

轻量 ELF/.so 静态检查：file + readelf + radare2 节表/字符串 + LIEF 解析。
不做全量分析（aaa）或 Ghidra/IDA。Java/Kotlin 仍走 JADX；这不是设备证据。
EOF
}

lief_python() {
  printf '%s\n' "${MOBILE_PYTHON:-/opt/deepsonar/mobile-venv/bin/python}"
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  for command_name in file readelf objdump nm r2; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'SO 检查失败：缺少命令 %s\n' "$command_name" >&2
      exit 1
    }
  done
  readelf --version >/dev/null
  objdump --version >/dev/null
  r2 -qv >/dev/null
  "$(lief_python)" -c "import lief; print(lief.__version__)" >/dev/null
  printf 'Mobile SO helper 已就绪（binutils + radare2 + LIEF）\n'
  exit 0
fi

if [[ "${1:-}" == "inspect" && $# -eq 2 ]]; then
  so="$2"
  [[ -f "$so" ]] || {
    printf 'SO 检查失败：文件不存在 %s\n' "$so" >&2
    exit 1
  }
  file "$so"
  printf '\n----- readelf -h -----\n'
  readelf -h "$so"
  printf '\n----- r2 iI / iS / iz -----\n'
  r2 -qq -e scr.color=0 -c 'iI;iS;iz' "$so"
  printf '\n----- LIEF -----\n'
  "$(lief_python)" -c "import lief,sys; b=lief.parse(sys.argv[1]); print('lief: unparsed' if b is None else f'format={b.format} entry={hex(b.entrypoint)}')" "$so"
  exit 0
fi

usage >&2
exit 2
