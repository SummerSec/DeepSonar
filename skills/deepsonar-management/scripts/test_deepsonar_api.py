import runpy
import unittest
from pathlib import Path


CLI_PATH = Path(__file__).with_name("deepsonar-api.py")


class DeepSonarApiCliTest(unittest.TestCase):
    def setUp(self):
        self.module = runpy.run_path(str(CLI_PATH), run_name="deepsonar_api_test")
        self.calls = []

        def fake_call(method, path, body=None):
            self.calls.append((method, path, body))
            return {"ok": True}

        for command in self.module["COMMANDS"].values():
            if hasattr(command, "__globals__"):
                command.__globals__["call"] = fake_call

    def run_command(self, key, pos=None, flags=None):
        return self.module["COMMANDS"][key](pos or [], flags or {})

    def test_readiness_and_evidence_queries_are_encoded(self):
        self.run_command(
            "readiness.project",
            ["project-id"],
            {"allow-egress": "true", "material-source": "declared"},
        )
        self.run_command("jobs.events", ["job-id"], {"cursor": "a+b/c=", "limit": "25"})
        self.run_command("jobs.evidence-stream", ["job-id"], {"tail": "true", "limit": "20"})

        self.assertEqual(
            self.calls,
            [
                (
                    "GET",
                    "/projects/project-id/readiness?allow_egress=true&material_source=declared",
                    None,
                ),
                ("GET", "/jobs/job-id/events?cursor=a%2Bb%2Fc%3D&limit=25", None),
                ("GET", "/jobs/job-id/evidence/stream?limit=20&tail=true", None),
            ],
        )

    def test_credential_read_and_refresh_use_distinct_methods(self):
        self.run_command("credentials.models", ["credential-id"])
        self.run_command("credentials.models-refresh", ["credential-id"])
        self.run_command(
            "credentials.compatibility",
            ["credential-id"],
            {"agent-cli": "codex", "model": "gpt 5"},
        )

        self.assertEqual(
            self.calls,
            [
                ("GET", "/credentials/credential-id/models", None),
                ("POST", "/credentials/credential-id/models", None),
                (
                    "GET",
                    "/credentials/credential-id/compatibility?agent_cli=codex&model=gpt+5",
                    None,
                ),
            ],
        )

    def test_transfer_and_registry_bodies_match_current_contract(self):
        self.run_command("runtime-images.registry-channel", flags={"channel": "aliyun-acr"})
        self.run_command(
            "exports.create",
            flags={"project-id": "project-id", "preset": "project_full", "include-blobs": "true"},
        )
        self.run_command(
            "imports.apply",
            ["import-id"],
            {"mode": "create_new", "project-name": "restored"},
        )

        self.assertEqual(
            self.calls,
            [
                ("PATCH", "/runtime-images/registry/channel", {"channel": "aliyun-acr"}),
                (
                    "POST",
                    "/projects/project-id/exports",
                    {"preset": "project_full", "include_blobs": True},
                ),
                (
                    "POST",
                    "/imports/import-id/apply",
                    {"mode": "create_new", "project_name": "restored"},
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main()
