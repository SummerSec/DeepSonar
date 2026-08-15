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

    def test_task_creation_supports_compose_and_scheduling(self):
        self.run_command(
            "tasks.create",
            ["project-id"],
            {
                "title": "组合验证",
                "kind": "compose",
                "seed-finding-ids": "finding-1,finding-2",
                "scheduled-start-at": "2026-08-20T01:00:00.000Z",
                "schedule-beijing-8am": "true",
            },
        )

        self.assertEqual(
            self.calls,
            [(
                "POST",
                "/projects/project-id/tasks",
                {
                    "title": "组合验证",
                    "content": "组合验证",
                    "kind": "compose",
                    "seed_finding_ids": ["finding-1", "finding-2"],
                    "scheduled_start_at": "2026-08-20T01:00:00.000Z",
                    "schedule_beijing_8am": True,
                },
            )],
        )

    def test_task_creation_rejects_invalid_seed_combinations(self):
        with self.assertRaisesRegex(self.module["ApiError"], "standard 任务禁止"):
            self.run_command(
                "tasks.create", ["project-id"],
                {"title": "bad", "kind": "standard", "seed-finding-ids": "finding-1"},
            )
        with self.assertRaisesRegex(self.module["ApiError"], "compose 任务必须"):
            self.run_command("tasks.create", ["project-id"], {"title": "bad", "kind": "compose"})

    def test_fact_ledgers_messages_and_provision_limit_use_current_contract(self):
        self.run_command(
            "facts.list", ["canvas-id"],
            {"verification-status": "needs_human", "evidence-kind": "review,test", "limit": "20"},
        )
        self.run_command("facts.get", ["canvas-id", "node-id"])
        self.run_command("facts.verify", ["canvas-id", "node-id"], {"status": "verified", "note": "人工确认"})
        self.run_command("canvases.broadcasts", ["canvas-id"], {"limit": "10"})
        self.run_command("messages.list", ["canvas-id"], {"limit": "30"})
        self.run_command(
            "messages.send", ["canvas-id"],
            {
                "message-id": "message-id",
                "target-kind": "job",
                "target-node-id": "target-node-id",
                "body": "继续验证",
                "attachment-version-ids": "version-1,version-2",
            },
        )
        self.run_command("settings.update", flags={"max-concurrent-provisioning": "1"})

        self.assertEqual(
            self.calls,
            [
                ("GET", "/canvases/canvas-id/facts?limit=20&verification_status=needs_human&evidence_kind=review%2Ctest", None),
                ("GET", "/canvases/canvas-id/facts/node-id", None),
                ("PATCH", "/canvases/canvas-id/facts/node-id/verification", {"status": "verified", "note": "人工确认"}),
                ("GET", "/canvases/canvas-id/broadcasts?limit=10", None),
                ("GET", "/canvases/canvas-id/messages?limit=30", None),
                (
                    "POST", "/canvases/canvas-id/messages",
                    {
                        "message_id": "message-id",
                        "target": {"kind": "job", "node_id": "target-node-id"},
                        "body": "继续验证",
                        "attachment_version_ids": ["version-1", "version-2"],
                    },
                ),
                ("PATCH", "/global-settings", {"rules": {"maxConcurrentProvisioning": 1}}),
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
