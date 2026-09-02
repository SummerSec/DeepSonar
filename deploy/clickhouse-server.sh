#!/usr/bin/env bash
# Scheduler-governed local ClickHouse server launcher. Agents receive this
# wrapper instead of a free-form clickhouse-server command, so listen address,
# data path, memory and thread pools cannot leave the sandbox budget.
set -euo pipefail

bin="${CLICKHOUSE_BIN:-/opt/deepsonar/bin/clickhouse}"
path="${CLICKHOUSE_PATH:-/workspace/.clickhouse}"
http_port="${CLICKHOUSE_HTTP_PORT:-8123}"
tcp_port="${CLICKHOUSE_TCP_PORT:-9000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) [[ $# -ge 2 ]] || { echo '缺少 --path 参数值' >&2; exit 2; }; path="$2"; shift 2 ;;
    --http-port) [[ $# -ge 2 ]] || { echo '缺少 --http-port 参数值' >&2; exit 2; }; http_port="$2"; shift 2 ;;
    --tcp-port) [[ $# -ge 2 ]] || { echo '缺少 --tcp-port 参数值' >&2; exit 2; }; tcp_port="$2"; shift 2 ;;
    -h|--help) echo '用法：clickhouse-server.sh [--path PATH] [--http-port N] [--tcp-port N]'; exit 0 ;;
    *) printf '不允许的 ClickHouse 参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$path" == /workspace/* ]] || { echo 'data path 必须位于 /workspace 下' >&2; exit 2; }
[[ "$http_port" =~ ^[1-9][0-9]{2,4}$ ]] || { echo 'http-port 必须是有效端口' >&2; exit 2; }
[[ "$tcp_port" =~ ^[1-9][0-9]{2,4}$ ]] || { echo 'tcp-port 必须是有效端口' >&2; exit 2; }

xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  s=${s//\"/&quot;}
  printf '%s' "$s"
}

mkdir -p "$path/data" "$path/tmp" "$path/user_files" "$path/format_schemas" "$path/access"
escaped_path="$(xml_escape "$path")"
cat >"$path/config.xml" <<EOF
<clickhouse>
  <logger>
    <level>warning</level>
    <console>true</console>
  </logger>
  <listen_host>127.0.0.1</listen_host>
  <http_port>${http_port}</http_port>
  <tcp_port>${tcp_port}</tcp_port>
  <path>${escaped_path}/data/</path>
  <tmp_path>${escaped_path}/tmp/</tmp_path>
  <user_files_path>${escaped_path}/user_files/</user_files_path>
  <format_schema_path>${escaped_path}/format_schemas/</format_schema_path>
  <access_control_path>${escaped_path}/access/</access_control_path>
  <user_directories>
    <users_xml>
      <path>${escaped_path}/users.xml</path>
    </users_xml>
  </user_directories>
  <mlock_executable>false</mlock_executable>
  <max_server_memory_usage>1073741824</max_server_memory_usage>
  <mark_cache_size>134217728</mark_cache_size>
  <uncompressed_cache_size>0</uncompressed_cache_size>
  <max_thread_pool_size>32</max_thread_pool_size>
  <max_thread_pool_free_size>4</max_thread_pool_free_size>
  <background_pool_size>2</background_pool_size>
  <background_schedule_pool_size>4</background_schedule_pool_size>
  <background_message_broker_schedule_pool_size>1</background_message_broker_schedule_pool_size>
  <background_distributed_schedule_pool_size>1</background_distributed_schedule_pool_size>
  <background_buffer_flush_schedule_pool_size>1</background_buffer_flush_schedule_pool_size>
  <send_crash_reports>
    <enabled>false</enabled>
  </send_crash_reports>
  <shutdown_wait_unfinished>0</shutdown_wait_unfinished>
</clickhouse>
EOF
cat >"$path/users.xml" <<'EOF'
<clickhouse>
  <users>
    <default>
      <password></password>
      <networks>
        <ip>127.0.0.1</ip>
        <ip>::1</ip>
      </networks>
      <profile>default</profile>
      <quota>default</quota>
    </default>
  </users>
  <profiles>
    <default>
      <max_memory_usage>805306368</max_memory_usage>
      <use_uncompressed_cache>0</use_uncompressed_cache>
    </default>
  </profiles>
  <quotas>
    <default>
      <interval>
        <duration>3600</duration>
        <queries>0</queries>
        <errors>0</errors>
        <result_rows>0</result_rows>
        <read_rows>0</read_rows>
        <execution_time>0</execution_time>
      </interval>
    </default>
  </quotas>
</clickhouse>
EOF

export CLICKHOUSE_WATCHDOG_ENABLE=0
exec "$bin" server --config-file "$path/config.xml"
