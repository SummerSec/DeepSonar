"""Authenticated, read-only List readiness. Create health comes from Dispatcher outcomes."""
import json
import os
import urllib.request

MAX_RESPONSE_BYTES = 65536
PROBE_TIMEOUT_SECONDS = 2


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe():
    key = os.environ.get("OPENSANDBOX_SERVER_API_KEY", "")
    if not key.strip():
        print("OPENSANDBOX_MANAGEMENT_KEY_MISSING")
        return 1
    try:
        port = int(os.environ.get("OPENSANDBOX_PROBE_PORT", "8080"))
        if not 1 <= port <= 65535:
            raise ValueError("invalid management port")
        url = f"http://127.0.0.1:{port}/v1/sandboxes?page=1&pageSize=1"
        request = urllib.request.Request(url, headers={"OPEN-SANDBOX-API-KEY": key}, method="GET")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            # Bound memory and reject non-List responses, even when they return HTTP 200.
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if response.status != 200 or len(data) > MAX_RESPONSE_BYTES:
                raise ValueError("invalid List response")
            payload = json.loads(data)
            if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
                raise ValueError("invalid List response")
        return 0
    except Exception:
        # Neither response bodies nor transport errors may expose the management key.
        print("OPENSANDBOX_MANAGEMENT_UNAVAILABLE")
        return 1


if __name__ == "__main__":
    raise SystemExit(probe())
