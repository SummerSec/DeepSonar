#!/usr/bin/env bash
# Write a sandbox-sized ClickHouse config. Official compiled defaults include an
# 8GiB uncompressed cache, multi-GiB mark caches and 10k-thread pools; those
# abort under the 2GiB / 512-pid smoke and Job sandbox budget.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo '用法：clickhouse-sandbox-config.sh PATH [http_port] [tcp_port]' >&2
  exit 2
fi
path="$1"
http_port="${2:-8123}"
tcp_port="${3:-9000}"
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

mkdir -p "$path/data" "$path/tmp" "$path/user_files" "$path/format_schemas" "$path/access" "$path/caches"
escaped_path="$(xml_escape "$path")"
cat >"$path/config.xml" <<EOF
<clickhouse>
  <logger>
    <level>warning</level>
    <console>true</console>
  </logger>
  <listen_host>127.0.0.1</listen_host>
  <listen_try>1</listen_try>
  <http_port>${http_port}</http_port>
  <tcp_port>${tcp_port}</tcp_port>
  <path>${escaped_path}/data/</path>
  <tmp_path>${escaped_path}/tmp/</tmp_path>
  <user_files_path>${escaped_path}/user_files/</user_files_path>
  <format_schema_path>${escaped_path}/format_schemas/</format_schema_path>
  <access_control_path>${escaped_path}/access/</access_control_path>
  <custom_cached_disks_base_directory>${escaped_path}/caches/</custom_cached_disks_base_directory>
  <user_directories>
    <users_xml>
      <path>${escaped_path}/users.xml</path>
    </users_xml>
  </user_directories>
  <mlock_executable>false</mlock_executable>
  <max_server_memory_usage>1073741824</max_server_memory_usage>
  <uncompressed_cache_size>0</uncompressed_cache_size>
  <mark_cache_size>134217728</mark_cache_size>
  <index_mark_cache_size>67108864</index_mark_cache_size>
  <mmap_cache_size>1024</mmap_cache_size>
  <compiled_expression_cache_size>1048576</compiled_expression_cache_size>
  <query_condition_cache_size>0</query_condition_cache_size>
  <page_cache_max_size>0</page_cache_max_size>
  <async_insert_threads>0</async_insert_threads>
  <cgroups_memory_usage_observer_wait_time>0</cgroups_memory_usage_observer_wait_time>
  <max_io_thread_pool_size>8</max_io_thread_pool_size>
  <max_backups_io_thread_pool_size>2</max_backups_io_thread_pool_size>
  <max_thread_pool_size>32</max_thread_pool_size>
  <max_thread_pool_free_size>4</max_thread_pool_free_size>
  <background_pool_size>4</background_pool_size>
  <background_merges_mutations_concurrency_ratio>2</background_merges_mutations_concurrency_ratio>
  <merge_tree>
    <number_of_free_entries_in_pool_to_execute_mutation>1</number_of_free_entries_in_pool_to_execute_mutation>
    <number_of_free_entries_in_pool_to_execute_optimize_entire_partition>1</number_of_free_entries_in_pool_to_execute_optimize_entire_partition>
    <number_of_free_entries_in_pool_to_lower_max_size_of_merge>1</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
  </merge_tree>
  <background_move_pool_size>1</background_move_pool_size>
  <background_fetches_pool_size>1</background_fetches_pool_size>
  <background_common_pool_size>1</background_common_pool_size>
  <background_schedule_pool_size>4</background_schedule_pool_size>
  <background_message_broker_schedule_pool_size>1</background_message_broker_schedule_pool_size>
  <background_distributed_schedule_pool_size>1</background_distributed_schedule_pool_size>
  <background_buffer_flush_schedule_pool_size>1</background_buffer_flush_schedule_pool_size>
  <async_load_databases>false</async_load_databases>
  <skip_binary_checksum_checks>1</skip_binary_checksum_checks>
  <disable_internal_dns_cache>1</disable_internal_dns_cache>
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
