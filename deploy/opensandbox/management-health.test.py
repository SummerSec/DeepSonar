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
        state = {"status": 200, "body": json.dumps({"items": []}).encode()}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.command, self.path, self.headers.get("OPEN-SANDBOX-API-KEY")))
                self.send_response(state["status"])
                self.send_header("Location", "/must-not-follow")
                self.end_headers()
                self.wfile.write(state["body"])

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/v1/sandboxes?page=1&pageSize=1"
        try:
            with patch.dict(os.environ, {"OPENSANDBOX_SERVER_API_KEY": "fixture-secret"}):
                self.assertEqual(health.probe(url), 0)
                for status, body in [(401, b"fixture-secret"), (500, b"fixture-secret"),
                                     (302, b"redirect"), (200, b'{"status":"ok"}'), (200, b"x" * 65537)]:
                    state.update(status=status, body=body)
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(health.probe(url), 1)
                    self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_UNAVAILABLE")
            with patch.dict(os.environ, {"OPENSANDBOX_SERVER_API_KEY": ""}):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(health.probe(url), 1)
                self.assertEqual(output.getvalue().strip(), "OPENSANDBOX_MANAGEMENT_KEY_MISSING")
            self.assertEqual(seen, [("GET", "/v1/sandboxes?page=1&pageSize=1", "fixture-secret")] * 6)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
