#!/usr/bin/env bash
# Install the pinned official clickhouse-common-static binary. Build-time only.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo '用法：clickhouse-install-static.sh <amd64|arm64> <tarball-url> <sha256>' >&2
  exit 2
fi

arch="$1"
url="$2"
sha256="$3"
[[ "$arch" == "amd64" || "$arch" == "arm64" ]] || {
  printf 'unsupported architecture: %s\n' "$arch" >&2
  exit 1
}
[[ "$url" == https://github.com/ClickHouse/ClickHouse/releases/download/* ]] || {
  echo 'ClickHouse tarball must come from the official GitHub Release' >&2
  exit 1
}
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'ClickHouse tarball SHA-256 is invalid' >&2
  exit 1
}

curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 "$url" -o /tmp/clickhouse.tgz
echo "$sha256  /tmp/clickhouse.tgz" | sha256sum -c -
mkdir -p /tmp/clickhouse-extract /opt/deepsonar/bin
tar -xzf /tmp/clickhouse.tgz -C /tmp/clickhouse-extract
bin="$(find /tmp/clickhouse-extract -type f -name clickhouse -print -quit)"
test -n "$bin" -a -x "$bin"
install -m 0755 "$bin" /opt/deepsonar/bin/clickhouse
ln -sfn clickhouse /opt/deepsonar/bin/clickhouse-client
ln -sfn clickhouse /opt/deepsonar/bin/clickhouse-local
ln -sfn clickhouse /opt/deepsonar/bin/clickhouse-server
rm -rf /tmp/clickhouse.tgz /tmp/clickhouse-extract
