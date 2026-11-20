"""Offline HTTP contract for the exact Compose readiness script."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("management_health", Path(__file__).with_name("management-health.py"))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class ManagementHealthTest(unittest.TestCase):
    def test_authenticated_list_and_fixed_errors(self):
        seen = []
        state = {"status": 200, "body": json.dumps({"items": []}).encode(), "slow": False}
        release = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.command, self.path, self.headers.get("OPEN-SANDBOX-API-KEY")))
                if state["slow"]:
                    release.wait(timeout=2)
                try:
                    self.send_response(state["status"])
                    self.send_header("Location", "/must-not-follow")
                    self.end_headers()
                    self.wfile.write(state["body"])
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        errors = [(401, b"fixture-secret"), (403, b"fixture-secret"), (404, b"fixture-secret"),
                  (500, b"fixture-secret"), (302, b"redirect"), (200, b'{"status":"ok"}'),
                  (200, b"invalid-json"), (200, b"[]"), (200, b"x" * 65537)]
        try:
            with patch.dict(os.environ, {"OPENSANDBOX_SERVER_API_KEY": "fixture-secret",
                                         "OPENSANDBOX_PROBE_PORT": str(server.server_port)}):
                self.assertEqual(health.probe(), 0)
                for status, body in errors:
                    state.update(status=status, body=body)
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(health.probe(), 1)
                    self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_UNAVAILABLE")
                state.update(status=200, body=b'{"items":[]}', slow=True)
                with patch.object(health, "PROBE_TIMEOUT_SECONDS", 0.2):
                    with contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(health.probe(), 1)
                    self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_UNAVAILABLE")
                release.set()
                for port in ["private-invalid-port", "0", "65536"]:
                    with patch.dict(os.environ, {"OPENSANDBOX_PROBE_PORT": port}):
                        with contextlib.redirect_stdout(io.StringIO()) as output:
                            self.assertEqual(health.probe(), 1)
                        self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_UNAVAILABLE")
            with patch.dict(os.environ, {"OPENSANDBOX_SERVER_API_KEY": ""}):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(health.probe(), 1)
                self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_KEY_MISSING")
            self.assertEqual(seen, [("GET", "/v1/sandboxes?page=1&pageSize=1", "fixture-secret")] * (len(errors) + 2))
        finally:
            release.set()
            server.shutdown()
            thread.join()
            server.server_close()

    def test_default_port_and_whitespace_key(self):
        with patch.dict(os.environ, {"OPENSANDBOX_SERVER_API_KEY": "fixture-secret"}):
            os.environ.pop("OPENSANDBOX_PROBE_PORT", None)
            with patch.object(health.urllib.request, "build_opener") as build:
                response = build.return_value.open.return_value.__enter__.return_value
                response.status = 200
                response.read.return_value = b'{"items":[]}'
                self.assertEqual(health.probe(), 0)
                request = build.return_value.open.call_args.args[0]
                self.assertEqual(request.full_url, "http://127.0.0.1:8080/v1/sandboxes?page=1&pageSize=1")
                response.read.assert_called_once_with(health.MAX_RESPONSE_BYTES + 1)
        with patch.dict(os.environ, {"OPENSANDBOX_SERVER_API_KEY": "  "}):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(health.probe(), 1)
            self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_KEY_MISSING")


if __name__ == "__main__":
    unittest.main()
