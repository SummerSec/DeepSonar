"""Authenticated, read-only List readiness. Create health comes from Dispatcher outcomes."""
import json
import os
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(url="http://127.0.0.1:8080/v1/sandboxes?page=1&pageSize=1"):
    key = os.environ.get("OPENSANDBOX_SERVER_API_KEY", "")
    if not key.strip():
        print("OPENSANDBOX_MANAGEMENT_KEY_MISSING")
        return 1
    try:
        request = urllib.request.Request(url, headers={"OPEN-SANDBOX-API-KEY": key}, method="GET")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=2) as response:
            # Bound memory and reject non-List responses, even when they return HTTP 200.
            data = response.read(65537)
            if response.status != 200 or len(data) > 65536:
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
