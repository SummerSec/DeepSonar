"""Read only the managed OpenSandbox Engine's declared resource capabilities (#1002)."""
import http.client
import json
import socket

SOCKET_PATH = "/var/run/docker.sock"
INFO_LIMIT = 256 * 1024
LIMITS = {"CpuCfsQuota": "CPU", "MemoryLimit": "memory", "PidsLimit": "PIDs"}


class ResourcePreflightError(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__("localhost", timeout=10)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def read_engine_info():
    connection = UnixHTTPConnection(SOCKET_PATH)
    try:
        connection.request("GET", "/info")
        response = connection.getresponse()
        if response.status != 200:
            raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNKNOWN", "Engine info is unavailable")
        body = response.read(INFO_LIMIT + 1)
        if len(body) > INFO_LIMIT:
            raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNKNOWN", "Engine info exceeds its read budget")
        return json.loads(body)
    finally:
        connection.close()


def validate_limits(info):
    if not isinstance(info, dict):
        raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNKNOWN", "Engine info must be an object")
    security = info.get("SecurityOptions")
    warnings = info.get("Warnings")
    security = [] if security is None else security
    warnings = [] if warnings is None else warnings
    if not isinstance(security, list) or not isinstance(warnings, list) or any(
        not isinstance(item, str) for item in security + warnings
    ):
        raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNKNOWN", "Engine capability shape is invalid")
    rootless = info.get("Rootless") is True or any(item in ("rootless", "name=rootless") for item in security)
    cgroup_version = str(info.get("CgroupVersion", "")).lower()
    if rootless and cgroup_version not in ("1", "v1", "2", "v2"):
        raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNKNOWN", "Rootless Engine cgroup version is unconfirmed")
    cgroups_v1 = cgroup_version in ("1", "v1")
    if (rootless and cgroups_v1) or any("resource limits are not supported" in item.lower() for item in warnings):
        raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNSUPPORTED", "Engine reports unenforceable resource limits")
    unsupported = [label for key, label in LIMITS.items() if info.get(key) is False]
    unknown = [label for key, label in LIMITS.items() if not isinstance(info.get(key), bool)]
    if unsupported:
        raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNSUPPORTED", "Unsupported limits: " + ", ".join(unsupported))
    if unknown:
        raise ResourcePreflightError("SANDBOX_RESOURCE_LIMITS_UNKNOWN", "Unconfirmed limits: " + ", ".join(unknown))


def main():
    try:
        validate_limits(read_engine_info())
    except ResourcePreflightError as error:
        print(error.code + ": " + str(error) + "; configure effective CPU/memory/PIDs controllers on the OpenSandbox Engine")
        return 1
    except Exception:
        # Never print Engine payloads, socket/driver details or credentials.
        print("SANDBOX_RESOURCE_LIMITS_UNKNOWN: cannot verify the managed OpenSandbox Engine")
        return 1
    print("SANDBOX_RESOURCE_PREFLIGHT_OK: Engine declares CPU/memory/PIDs support; not per-container enforcement proof")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
