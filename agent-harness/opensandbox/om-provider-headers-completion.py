"""Synthetic OM fixture client; all completion authority remains in Control API."""
import json
import multiprocessing
import os
import time
import urllib.error
import urllib.request
import uuid


PAYLOAD = {"summary": "Real Pi and OM completed the offline provider-header acceptance."}
RECOVERABLE = {"COMPLETION_EFFECT_UNKNOWN", "REPAIR_USAGE_PENDING", "REPAIR_USAGE_UNKNOWN"}
STOP_CODES = {"OM_COMPLETION_" + code for code in (
    "INACTIVE", "INITIAL_STATE_CONFLICT", "NOT_ALLOWED", "BUDGET_EXHAUSTED",
    "RESTORE_NOT_ALLOWED", "RESTORE_UNCONFIRMED", "REJECTED", "IDENTITY_CONFLICT",
    "RECOVERY_STOPPED", "REVISION_CONFLICT", "WAIT_EXHAUSTED", "CLIENT_ERROR")}


def stopped(code):
    return {"om_completion": "stopped", "code": code}


def accepted(body, revision):
    return (body.get("accepted") is True and body.get("operation") == "mark_job_done"
            and body.get("receipt_status") == "persisted_deferred"
            and body.get("proposal_revision") == revision)


def run(exchange, clock=time.monotonic, pause=time.sleep,
        new_key=lambda: str(uuid.uuid4()), budget_seconds=90, deadline=None):
    """Unknown transport never authorizes POST; receipt reads have no side effects.

    The injected transport is also used by offline tests. Neither its exceptions
    nor response bodies are included in the returned, public diagnostic object.
    """
    if deadline is None:
        deadline = clock() + budget_seconds

    def request(method, receipt_key=None, proposal=None):
        remaining = deadline - clock()
        if remaining <= 0:
            return 0, {}
        try:
            status, body = exchange(method, receipt_key=receipt_key, proposal=proposal,
                                    timeout=min(10, remaining))
            return (status, body) if isinstance(body, dict) else (0, {})
        except Exception:
            return 0, {}

    def state():
        status, body = request("GET")
        value = body.get("execution_state")
        return value if status == 200 and isinstance(value, dict) else {}

    initial = state()
    attempt = initial.get("active_attempt_id")
    if (initial.get("authority") != "scheduler" or initial.get("status") != "running"
            or not isinstance(attempt, str) or not attempt):
        return stopped("OM_COMPLETION_INACTIVE")
    if (initial.get("next_proposal_revision") != 0
            or initial.get("remaining_attempts", 0) <= 0
            or initial.get("accepted_terminal") is not None):
        return stopped("OM_COMPLETION_INITIAL_STATE_CONFLICT")
    if not set(initial.get("allowed_actions", [])).intersection({"correct_proposal", "reconcile_effects"}):
        return stopped("OM_COMPLETION_NOT_ALLOWED")

    proposal = {"key": new_key(), "revision": 0, "payload": dict(PAYLOAD)}
    used_keys = {proposal["key"]}
    status, body = request("POST", proposal=proposal)
    if status == 200 and accepted(body, 0):
        return {"om_completion": "accepted"}
    # Even a known rejection is confirmed through the immutable original key.
    # A 404 or unavailable lookup is not proof that the POST had no effect.
    for _ in range(90):
        if clock() >= deadline:
            break
        status, receipt = request("GET", receipt_key=proposal["key"])
        if status in (401, 403):
            return stopped("OM_COMPLETION_NOT_ALLOWED")
        current = state()
        if not current:
            pause(min(1, max(0, deadline - clock())))
            continue
        if (current.get("authority") != "scheduler" or current.get("status") != "running"
                or current.get("active_attempt_id") != attempt):
            return stopped("OM_COMPLETION_INACTIVE")
        if current.get("blocker") in ("repair_budget_exhausted", "repair_deadline_exhausted"):
            return stopped("OM_COMPLETION_BUDGET_EXHAUSTED")
        if status != 200:
            pause(min(1, max(0, deadline - clock())))
            continue
        if accepted(receipt, proposal["revision"]):
            # GET cannot restore the original executor's local completion gate.
            # Recheck current advice, then restore exactly once with original
            # key/revision/payload. This never creates a new proposal identity.
            current = state()
            if (current.get("authority") != "scheduler" or current.get("status") != "running"
                    or current.get("active_attempt_id") != attempt
                    or current.get("blocker") != "completion_already_accepted"
                    or not {"read_receipt", "wait_for_settlement"}.issubset(current.get("allowed_actions", []))):
                return stopped("OM_COMPLETION_RESTORE_NOT_ALLOWED")
            status, restored = request("POST", proposal=proposal)
            if status == 200 and accepted(restored, proposal["revision"]):
                return {"om_completion": "accepted"}
            # The single restore may also have an uncertain result. Do not POST
            # again or infer local restoration merely from historical acceptance.
            request("GET", receipt_key=proposal["key"])
            return stopped("OM_COMPLETION_RESTORE_UNCONFIRMED")
        repair = receipt.get("repair", {})
        original = receipt.get("recovery", {})
        latest = receipt.get("recovery_current", {})
        if (receipt.get("accepted") is not False or receipt.get("error_code") not in RECOVERABLE
                or not isinstance(repair, dict) or not isinstance(original, dict) or not isinstance(latest, dict)):
            return stopped("OM_COMPLETION_REJECTED")
        if (repair.get("idempotency_key") != proposal["key"]
                or repair.get("proposal_revision") != proposal["revision"]
                or original.get("target_attempt_id") != attempt
                or latest.get("target_attempt_id") != attempt
                or not original.get("recovery_ref")
                or latest.get("recovery_ref") != original.get("recovery_ref")
                or latest.get("target_job_id") != original.get("target_job_id")):
            return stopped("OM_COMPLETION_IDENTITY_CONFLICT")
        if latest.get("status") in ("stop_requested", "closed", "completion_accepted"):
            return stopped("OM_COMPLETION_RECOVERY_STOPPED")
        remaining = repair.get("remaining_budget", {})
        if (not isinstance(remaining, dict) or remaining.get("attempts", 0) <= 0
                or remaining.get("wall_time_sec", 0) <= 0 or remaining.get("tokens", 1) == 0
                or current.get("remaining_attempts", 0) <= 0 or proposal["revision"] >= 7):
            return stopped("OM_COMPLETION_BUDGET_EXHAUSTED")
        # Only Scheduler evidence and advice authorize a fresh proposal. Sleeping,
        # a changed model message, or an unknown count observed later do not.
        ready = (latest.get("status") == "awaiting_completion"
                 and latest.get("blocking") == {"unknown": 0, "pending": 0}
                 and latest.get("evidence_sha256") != original.get("evidence_sha256")
                 and isinstance(latest.get("evidence_sha256"), str)
                 and latest.get("recovery_revision", 0) > original.get("recovery_revision", 0))
        if ready:
            current = state()
            if (current.get("authority") != "scheduler" or current.get("status") != "running"
                    or current.get("active_attempt_id") != attempt):
                return stopped("OM_COMPLETION_INACTIVE")
            if current.get("next_proposal_revision") != proposal["revision"] + 1:
                return stopped("OM_COMPLETION_REVISION_CONFLICT")
            if current.get("remaining_attempts", 0) <= 0:
                return stopped("OM_COMPLETION_BUDGET_EXHAUSTED")
            if current.get("blocker") is None and "correct_proposal" in current.get("allowed_actions", []):
                key = new_key()
                if key in used_keys:
                    return stopped("OM_COMPLETION_IDENTITY_CONFLICT")
                used_keys.add(key)
                proposal = {"key": key, "revision": proposal["revision"] + 1, "payload": dict(PAYLOAD)}
                status, body = request("POST", proposal=proposal)
                if status == 200 and accepted(body, proposal["revision"]):
                    return {"om_completion": "accepted"}
        pause(min(1, max(0, deadline - clock())))
    return stopped("OM_COMPLETION_WAIT_EXHAUSTED")


def _http_worker(output, base_url, token, deadline):
    try:
        url = base_url.rstrip("/") + "/operations/mark_job_done"
        auth = "Bearer " + token

        def exchange(method, receipt_key=None, proposal=None, timeout=10):
            headers = {"Authorization": auth, "Content-Type": "application/json"}
            data = None
            target = url
            if receipt_key is not None:
                target += "?receipt_key=" + receipt_key
            if proposal is not None:
                headers.update({"Idempotency-Key": proposal["key"],
                                "X-Deepsonar-Proposal-Revision": str(proposal["revision"])})
                data = json.dumps(proposal["payload"], separators=(",", ":")).encode()
            request = urllib.request.Request(target, data=data, headers=headers, method=method)
            try:
                response = urllib.request.urlopen(request, timeout=timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.loads(response.read(262145))

        result = run(exchange, deadline=deadline)
    except Exception:
        result = stopped("OM_COMPLETION_CLIENT_ERROR")
    try:
        output.send(result)
    except (BrokenPipeError, EOFError, OSError):
        pass
    finally:
        output.close()


def run_http(base_url, token, budget_seconds=90):
    # Linux native fixture: fork also works when the program is supplied via
    # stdin. One parent-owned deadline covers startup, DNS/connect, headers,
    # streaming bodies and every protocol query/retry. Socket idle timeouts alone
    # cannot bound a peer that continuously drips bytes.
    deadline = time.monotonic() + budget_seconds
    context = multiprocessing.get_context("fork")
    receiver, sender = context.Pipe(duplex=False)
    worker = context.Process(target=_http_worker, args=(sender, base_url, token, deadline), daemon=True)
    try:
        if time.monotonic() >= deadline:
            return stopped("OM_COMPLETION_WAIT_EXHAUSTED")
        worker.start()
        sender.close()
        if not receiver.poll(max(0, deadline - time.monotonic())):
            return stopped("OM_COMPLETION_WAIT_EXHAUSTED")
        result = receiver.recv()
        if time.monotonic() >= deadline:
            return stopped("OM_COMPLETION_WAIT_EXHAUSTED")
        if result == {"om_completion": "accepted"}:
            return result
        if (isinstance(result, dict) and set(result) == {"om_completion", "code"}
                and result.get("om_completion") == "stopped" and result.get("code") in STOP_CODES):
            return result
        return stopped("OM_COMPLETION_CLIENT_ERROR")
    except Exception:
        return stopped("OM_COMPLETION_CLIENT_ERROR")
    finally:
        # Even a successful child must be gone before returning. Killing a
        # timed-out client does NOT undo a POST already delivered to Scheduler;
        # no new helper/key may be started to guess its outcome.
        if worker.pid is not None:
            if worker.is_alive():
                worker.kill()
            worker.join()
        receiver.close()
        sender.close()
        worker.close()


def main():
    try:
        result = run_http(os.environ["DEEPSONAR_API_BASE_URL"], os.environ["DEEPSONAR_API_TOKEN"])
    except Exception:
        result = stopped("OM_COMPLETION_CLIENT_ERROR")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
