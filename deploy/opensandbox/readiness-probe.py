# OpenSandbox 就绪探针（#1046 P1-4 方案 1）。
#
# 与 dispatcher 的探测完全同口径：带鉴权的管理面 List
# （GET /sandboxes，只读幂等；401 / 403 / 5xx / 慢 List 均判 unhealthy）。
# `GET /health` 只证进程存活；事故形态「List 200 + POST 500」下 /health
# 依旧绿灯，因此不再作为就绪条件（见 docker-compose.opensandbox.prod.yml）。

import http.client
import os
import sys

HOST = "127.0.0.1"
def probe_port() -> int:
    raw = os.environ.get("OPENSANDBOX_PROBE_PORT", "8080")
    try:
        return int(raw)
    except ValueError as error:
        print(f"readiness probe failed: bad OPENSANDBOX_PROBE_PORT {raw!r}", file=sys.stderr)
        raise SystemExit(1) from error


PORT = probe_port()
PATH = "/sandboxes?page=1&pageSize=1"
TIMEOUT_SECONDS = 5


def main() -> int:
    key = os.environ.get("OPENSANDBOX_SERVER_API_KEY", "")
    if not key:
        print("readiness probe failed: OPENSANDBOX_SERVER_API_KEY unset", file=sys.stderr)
        return 1
    connection = http.client.HTTPConnection(HOST, PORT, timeout=TIMEOUT_SECONDS)
    try:
        connection.request("GET", PATH, headers={"OPEN-SANDBOX-API-KEY": key})
        response = connection.getresponse()
        status = response.status
        response.read()
    except Exception as error:  # noqa: BLE001 - healthcheck 只取成败
        print(f"readiness probe failed: {error}", file=sys.stderr)
        return 1
    finally:
        connection.close()
    if status != 200:
        print(f"readiness probe failed: HTTP {status}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
