import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("resource_preflight", Path(__file__).with_name("resource-preflight.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class ResourcePreflightTests(unittest.TestCase):
    def info(self, **overrides):
        return {"CpuCfsQuota": True, "MemoryLimit": True, "PidsLimit": True,
                "CgroupVersion": "2", "SecurityOptions": [], "Warnings": None, **overrides}

    def rejects(self, info, code):
        with self.assertRaises(preflight.ResourcePreflightError) as result:
            preflight.validate_limits(info)
        self.assertEqual(result.exception.code, code)

    def test_supported_rootful_and_delegated_rootless(self):
        for info in (self.info(), self.info(CgroupVersion="1"), self.info(SecurityOptions=["name=rootless"])):
            preflight.validate_limits(info)

    def test_rootless_cgroups_v1_is_rejected_even_if_flags_claim_support(self):
        for version in (1, "1", "v1"):
            for rootless in ({"SecurityOptions": ["name=rootless"]}, {"Rootless": True}):
                self.rejects(self.info(CgroupVersion=version, **rootless), "SANDBOX_RESOURCE_LIMITS_UNSUPPORTED")

    def test_each_disabled_controller_and_explicit_warning(self):
        for key in preflight.LIMITS:
            self.rejects(self.info(**{key: False}), "SANDBOX_RESOURCE_LIMITS_UNSUPPORTED")
        self.rejects(self.info(Warnings=["Resource limits are not supported and ignored on cgroups V1 rootless systems"]),
                     "SANDBOX_RESOURCE_LIMITS_UNSUPPORTED")

    def test_missing_or_non_boolean_capabilities_fail_closed(self):
        for key in preflight.LIMITS:
            for value in (None, 0, 1, "true", "false"):
                self.rejects(self.info(**{key: value}), "SANDBOX_RESOURCE_LIMITS_UNKNOWN")
            info = self.info()
            del info[key]
            self.rejects(info, "SANDBOX_RESOURCE_LIMITS_UNKNOWN")
        for info in (None, [], self.info(SecurityOptions=[{}]), self.info(SecurityOptions={}),
                     self.info(Warnings=""), self.info(Warnings="unsupported"),
                     self.info(SecurityOptions=["name=rootless"], CgroupVersion=None)):
            self.rejects(info, "SANDBOX_RESOURCE_LIMITS_UNKNOWN")

    def test_engine_query_is_read_only_and_bounded(self):
        with patch.object(preflight, "UnixHTTPConnection") as factory:
            connection = factory.return_value
            connection.getresponse.return_value.status = 200
            connection.getresponse.return_value.read.return_value = json.dumps(self.info()).encode()
            preflight.validate_limits(preflight.read_engine_info())
            factory.assert_called_once_with("/var/run/docker.sock")
            connection.request.assert_called_once_with("GET", "/info")
            connection.getresponse.return_value.read.assert_called_once_with(preflight.INFO_LIMIT + 1)
            connection.close.assert_called_once()
        for status, body in ((503, b"secret"), (200, b"x" * (preflight.INFO_LIMIT + 1))):
            with patch.object(preflight, "UnixHTTPConnection") as factory:
                response = factory.return_value.getresponse.return_value
                response.status, response.read.return_value = status, body
                with self.assertRaises(preflight.ResourcePreflightError):
                    preflight.read_engine_info()
                factory.return_value.close.assert_called_once()

    def test_startup_exit_and_redaction(self):
        for response, code in ((self.info(), 0), (self.info(PidsLimit=False), 1), ([], 1)):
            output = io.StringIO()
            with patch.object(preflight, "read_engine_info", return_value=response), contextlib.redirect_stdout(output):
                self.assertEqual(preflight.main(), code)
            self.assertIn("SANDBOX_RESOURCE_", output.getvalue())
        output = io.StringIO()
        with patch.object(preflight, "read_engine_info", side_effect=OSError("credential=must-not-leak")), contextlib.redirect_stdout(output):
            self.assertEqual(preflight.main(), 1)
        self.assertNotIn("must-not-leak", output.getvalue())
        self.assertIn("SANDBOX_RESOURCE_LIMITS_UNKNOWN", output.getvalue())


if __name__ == "__main__":
    unittest.main()
