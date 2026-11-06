"""Offline protocol regression; run only in GitHub Actions."""
import copy
import importlib.util
import pathlib
import unittest


spec = importlib.util.spec_from_file_location(
    "completion", pathlib.Path(__file__).with_name("om-provider-headers-completion.py"))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
ATTEMPT = "11111111-1111-4111-8111-111111111111"
KEYS = [f"22222222-2222-4222-8222-{i:012d}" for i in range(10)]


def state(revision=0, **patch):
    return {"authority": "scheduler", "status": "running", "active_attempt_id": ATTEMPT,
            "accepted_terminal": None, "allowed_actions": ["correct_proposal"], "blocker": None,
            "next_proposal_revision": revision, "remaining_attempts": 8 - revision, **patch}


def accepted(revision=0):
    return {"accepted": True, "operation": "mark_job_done", "receipt_status": "persisted_deferred",
            "proposal_revision": revision}


def rejection(revision=0, ready=True):
    original = {"target_attempt_id": ATTEMPT, "target_job_id": "job", "recovery_ref": "recovery",
                "status": "needed", "blocking": {"unknown": 0, "pending": 1},
                "evidence_sha256": "a" * 64, "recovery_revision": 10}
    latest = {**original, **({"status": "awaiting_completion", "blocking": {"unknown": 0, "pending": 0},
                             "evidence_sha256": "b" * 64, "recovery_revision": 12} if ready else {})}
    return {"accepted": False, "error_code": "COMPLETION_EFFECT_UNKNOWN", "recovery": original,
            "recovery_current": latest, "repair": {"idempotency_key": KEYS[revision],
            "proposal_revision": revision, "remaining_budget": {"attempts": 7 - revision, "wall_time_sec": 80}}}


class Fixture:
    def __init__(self, posts=None, receipt=None, states=None):
        self.posts = posts or [(200, accepted())]
        self.receipt = receipt or (200, accepted())
        self.states = states or [state()]
        self.calls = []
        self.now = 0
        self.keys = iter(KEYS)
        self.post_count = 0
        self.state_count = 0

    def exchange(self, method, receipt_key=None, proposal=None, timeout=10):
        self.calls.append((method, receipt_key, copy.deepcopy(proposal), timeout))
        if method == "POST":
            result = self.posts[min(self.post_count, len(self.posts) - 1)]
            self.post_count += 1
        elif receipt_key is not None:
            result = self.receipt
        else:
            result = 200, {"execution_state": self.states[min(self.state_count, len(self.states) - 1)]}
            self.state_count += 1
        if isinstance(result, Exception):
            raise result
        return copy.deepcopy(result)

    def pause(self, seconds):
        self.now += seconds

    def run(self):
        return client.run(self.exchange, clock=lambda: self.now, pause=self.pause,
                          new_key=lambda: next(self.keys), budget_seconds=5)


class CompletionProtocolTests(unittest.TestCase):
    def test_first_acceptance_requires_durable_status(self):
        fixture = Fixture()
        self.assertEqual(fixture.run(), {"om_completion": "accepted"})
        self.assertEqual(fixture.post_count, 1)
        fixture = Fixture(posts=[(200, {"accepted": True})], receipt=(404, {}))
        self.assertEqual(fixture.run()["om_completion"], "stopped")
        self.assertEqual(fixture.post_count, 1)

    def test_confirmed_rejection_needs_changed_authority_and_next_revision(self):
        fixture = Fixture(posts=[(409, rejection()), (200, accepted(1))],
                          receipt=(200, rejection()), states=[state(), state(1)])
        self.assertEqual(fixture.run(), {"om_completion": "accepted"})
        proposals = [call[2] for call in fixture.calls if call[0] == "POST"]
        self.assertEqual([p["key"] for p in proposals], KEYS[:2])
        self.assertEqual([p["revision"] for p in proposals], [0, 1])
        self.assertEqual(proposals[0]["payload"], proposals[1]["payload"])
        self.assertTrue(any(call[1] == KEYS[0] for call in fixture.calls))

    def test_unknown_post_looks_up_original_key_then_restores_same_identity_once(self):
        fixture = Fixture(posts=[TimeoutError("private token request text"), (200, accepted())],
                          states=[state(), state(1, blocker="completion_already_accepted",
                                                allowed_actions=["read_receipt", "wait_for_settlement"])])
        self.assertEqual(fixture.run(), {"om_completion": "accepted"})
        proposals = [call[2] for call in fixture.calls if call[0] == "POST"]
        self.assertEqual(proposals[0], proposals[1])
        self.assertEqual(fixture.post_count, 2)
        first_post = next(i for i, call in enumerate(fixture.calls) if call[0] == "POST")
        next_post = next(i for i, call in enumerate(fixture.calls) if i > first_post and call[0] == "POST")
        self.assertTrue(any(call[1] == KEYS[0] for call in fixture.calls[first_post + 1:next_post]))

    def test_uncertain_restore_is_not_repeated_or_claimed_restored(self):
        fixture = Fixture(posts=[TimeoutError(), TimeoutError()],
                          states=[state(), state(1, blocker="completion_already_accepted",
                                                allowed_actions=["read_receipt", "wait_for_settlement"])])
        self.assertEqual(fixture.run(), client.stopped("OM_COMPLETION_RESTORE_UNCONFIRMED"))
        self.assertEqual(fixture.post_count, 2)
        self.assertEqual(fixture.calls[-1][1], KEYS[0])

    def test_missing_or_unavailable_receipt_never_reposts(self):
        for receipt in [(404, {}), (503, {}), TimeoutError("secret")]:
            with self.subTest(receipt=type(receipt).__name__):
                fixture = Fixture(posts=[TimeoutError("secret")], receipt=receipt)
                result = fixture.run()
                self.assertEqual(result, client.stopped("OM_COMPLETION_WAIT_EXHAUSTED"))
                self.assertEqual(fixture.post_count, 1)
                self.assertNotIn("secret", str(result))
                self.assertTrue(all(call[1] in (None, KEYS[0]) for call in fixture.calls))

    def test_unchanged_or_still_blocking_evidence_cannot_authorize_reproposal(self):
        for patch in [{"evidence_sha256": "a" * 64}, {"blocking": {"unknown": 1, "pending": 0}},
                      {"status": "needed"}, {"recovery_revision": 10}]:
            with self.subTest(patch=patch):
                receipt = rejection()
                receipt["recovery_current"].update(patch)
                fixture = Fixture(posts=[(409, receipt)], receipt=(200, receipt), states=[state(), state(1)])
                self.assertEqual(fixture.run()["code"], "OM_COMPLETION_WAIT_EXHAUSTED")
                self.assertEqual(fixture.post_count, 1)

    def test_attempt_and_receipt_identity_are_preserved(self):
        for field, value in [("idempotency_key", KEYS[1]), ("proposal_revision", 7)]:
            receipt = rejection()
            receipt["repair"][field] = value
            fixture = Fixture(posts=[(409, receipt)], receipt=(200, receipt), states=[state(), state(1)])
            self.assertEqual(fixture.run()["code"], "OM_COMPLETION_IDENTITY_CONFLICT")
            self.assertEqual(fixture.post_count, 1)

    def test_duplicate_new_key_is_rejected_before_another_post(self):
        fixture = Fixture(posts=[(409, rejection())], receipt=(200, rejection()), states=[state(), state(1)])
        fixture.keys = iter([KEYS[0], KEYS[0]])
        self.assertEqual(fixture.run()["code"], "OM_COMPLETION_IDENTITY_CONFLICT")
        self.assertEqual(fixture.post_count, 1)

    def test_terminal_or_changed_attempt_stops(self):
        for patch in [{"active_attempt_id": "another"}, {"status": "cancelled"}, {"status": "timeout"}]:
            fixture = Fixture(posts=[TimeoutError()], states=[state(), state(1, **patch)])
            self.assertEqual(fixture.run()["code"], "OM_COMPLETION_INACTIVE")
            self.assertEqual(fixture.post_count, 1)

    def test_budget_terminal_and_revision_conflicts_stop(self):
        for patch, code in [({"remaining_attempts": 0}, "OM_COMPLETION_BUDGET_EXHAUSTED"),
                            ({"next_proposal_revision": 3}, "OM_COMPLETION_REVISION_CONFLICT")]:
            fixture = Fixture(posts=[(409, rejection())], receipt=(200, rejection()),
                              states=[state(), state(1, **patch)])
            self.assertEqual(fixture.run()["code"], code)
            self.assertEqual(fixture.post_count, 1)
        receipt = rejection()
        receipt["recovery_current"]["status"] = "stop_requested"
        fixture = Fixture(posts=[(409, receipt)], receipt=(200, receipt), states=[state(), state(1)])
        self.assertEqual(fixture.run()["code"], "OM_COMPLETION_RECOVERY_STOPPED")

    def test_receipt_budget_exhaustion_is_not_overridden_by_current_advice(self):
        for field in ["attempts", "wall_time_sec", "tokens"]:
            receipt = rejection()
            receipt["repair"]["remaining_budget"][field] = 0
            fixture = Fixture(posts=[(409, receipt)], receipt=(200, receipt), states=[state(), state(1)])
            self.assertEqual(fixture.run()["code"], "OM_COMPLETION_BUDGET_EXHAUSTED")
            self.assertEqual(fixture.post_count, 1)

    def test_recovery_cannot_switch_target_or_reference(self):
        for field in ["target_attempt_id", "target_job_id", "recovery_ref"]:
            receipt = rejection()
            receipt["recovery_current"][field] = "another"
            fixture = Fixture(posts=[(409, receipt)], receipt=(200, receipt), states=[state(), state(1)])
            self.assertEqual(fixture.run()["code"], "OM_COMPLETION_IDENTITY_CONFLICT")
            self.assertEqual(fixture.post_count, 1)

    def test_permanent_rejection_and_forbidden_receipt_stop_without_new_identity(self):
        for receipt in [(200, {"accepted": False, "error_code": "IDEMPOTENCY_KEY_CONFLICT"}),
                        (403, {"error": "private"})]:
            fixture = Fixture(posts=[(409, {})], receipt=receipt)
            self.assertEqual(fixture.run()["om_completion"], "stopped")
            self.assertEqual(fixture.post_count, 1)


if __name__ == "__main__":
    unittest.main()
