import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { api } from "./api";
import { ApiRequestError } from "./login-error";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import { classifyJobRerunError, CredentialRepairNotice, useJobRerun } from "./useJobRerun";

function stale(body: Record<string, unknown>, status = 409, errorCode = "SNAPSHOT_STALE") {
  return new ApiRequestError({ method: "POST", path: "/jobs/fixture/resume", status, errorCode,
    serverMessage: "fixture rejection", taskContractFeedback: body as ApiRequestError["taskContractFeedback"] });
}

test("credential repair requires structured code and a current-resolution failure", () => {
  for (const code of ["provider_credential_allowlist_stale", "provider_credential_multi_match"]) {
    const result = classifyJobRerunError(stale({ resolution_error: "human explanation", repair: { code } }), "project/a");
    assert.ok(result.repair);
    assert.equal(result.repair.projectSettingsHref, "/projects/project%2Fa/settings?tab=roles");
    assert.equal(result.repair.kind, code.endsWith("stale") ? "stale_references" : "multiple_accounts");
    const html = renderToStaticMarkup(<CredentialRepairNotice {...result} />);
    assert.match(html, /修复项目账号设置/);
    assert.match(html, /配置 Provider 凭据/);
  }
  assert.ok(classifyJobRerunError(stale({ stale_fields: ["current_snapshot_unresolvable"], repair: { code: "provider_credential_multi_match" } }), null).repair);
  const negative = [
    new Error("provider_credential_allowlist_stale"),
    stale({ resolution_error: "项目凭据白名单包含不存在、停用或不可访问的凭据" }),
    stale({ resolution_error: "failed", repair: { code: "provider_credential_allowlist_stale" } }, 409, "REPAIR_USAGE_UNKNOWN"),
    stale({ resolution_error: "failed", repair: { code: "provider_credential_allowlist_stale" } }, 409, "LEASE_EXPIRED"),
    stale({ resolution_error: "failed", repair: { code: "provider_credential_allowlist_stale" } }, 409, "TARGET_AUTHORIZATION_BLOCKED"),
    stale({ resolution_error: "provider_credential_allowlist_stale: human string" }),
    stale({ repair: { code: "provider_credential_allowlist_stale" } }),
    stale({ resolution_error: "failed", repair: { code: "provider_credential_allowlist_stale" } }, 500),
    stale({ resolution_error: "failed", repair: { code: "provider_credential_allowlist_stale" } }, 409, "OTHER"),
    stale({ resolution_error: "failed", repair: { code: "model_not_in_catalog" } }),
  ];
  for (const error of negative) assert.equal(classifyJobRerunError(error, "p").repair, null);
});

test("ordinary drift and current unresolvable configuration have distinct feedback without credential links", () => {
  const drift = classifyJobRerunError(stale({ next_action: "rerun-current", stale_fields: ["credential"] }), "p");
  assert.match(drift.message, /旧冻结快照与当前运行身份不一致/);
  assert.equal(drift.repair, null);
  const current = classifyJobRerunError(stale({ next_action: "fix-current-configuration", resolution_error: "failed" }), "p");
  assert.match(current.message, /当前运行配置无法解析/);
  assert.equal(current.repair, null);
  assert.doesNotMatch(renderToStaticMarkup(<CredentialRepairNotice {...current} />), /<a /);
  const ordinary = new Error("permission refused");
  assert.equal(classifyJobRerunError(ordinary, "p").message, ordinary.message);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("rerun fences confirmation, request and success work across duplicate clicks, cancellation, switches and unmount", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const originalResume = api.resumeJob;
  const originalCurrent = api.rerunJobCurrent;
  const requests: Array<{ job: string; mode: string; pending: ReturnType<typeof deferred<unknown>> }> = [];
  api.resumeJob = ((job: string) => { const pending = deferred<unknown>(); requests.push({ job, mode: "resume", pending }); return pending.promise; }) as typeof api.resumeJob;
  api.rerunJobCurrent = ((job: string) => { const pending = deferred<unknown>(); requests.push({ job, mode: "current", pending }); return pending.promise; }) as typeof api.rerunJobCurrent;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let action!: ReturnType<typeof useJobRerun>;
  function Harness({ scope }: { scope: string }) { action = useJobRerun(scope); return <CredentialRepairNotice message={action.message} repair={action.repair} />; }
  const render = (scope: string) => act(async () => root.render(<ConfirmDialogProvider><Harness scope={scope} /></ConfirmDialogProvider>));
  const answer = async (label: string) => {
    const button = Array.from(dom.window.document.querySelectorAll("button")).find((item) => item.textContent === label);
    assert.ok(button, `confirmation button ${label}`);
    await act(async () => button.click());
  };
  const input = { jobId: "job-a", projectId: "project-a", mode: "resume" as const };
  let successes = 0;
  try {
    await render("a");
    await act(async () => { void action.run(input); void action.run(input); });
    assert.equal(action.busy, "resume");
    assert.equal(dom.window.document.querySelectorAll('[role="alertdialog"]').length, 1);
    await answer("取消");
    assert.equal(requests.length, 0);
    assert.equal(action.busy, null);
    assert.equal(action.message, null);

    // A confirmation opened for the old scope must never issue a request for it after navigation.
    await act(async () => { void action.run(input); });
    await render("b");
    assert.equal(action.busy, null);
    await answer("旧快照重跑");
    assert.equal(requests.length, 0);

    await act(async () => { void action.run({ ...input, mode: "current", onSuccess: () => { successes += 1; } }); });
    await answer("当前配置重跑");
    await act(async () => { void action.run(input); });
    assert.equal(requests.length, 1, "duplicate during network work does not start another confirmation/request");
    await render("c");
    await act(async () => requests[0].pending.resolve({}));
    assert.equal(successes, 0);
    assert.equal(action.message, null);

    await act(async () => { void action.run(input); });
    await answer("旧快照重跑");
    await act(async () => requests[1].pending.reject(stale({ resolution_error: "failed", repair: { code: "provider_credential_allowlist_stale" } })));
    assert.equal(action.repair?.kind, "stale_references");
    await act(async () => { void action.run(input); });
    await answer("取消");
    assert.equal(action.message, null, "explicit new action clears prior feedback even when cancelled");
    assert.equal(action.repair, null);

    const refreshed = deferred<void>();
    let mayApply!: () => boolean;
    await act(async () => { void action.run({ ...input, onSuccess: async (isCurrent) => { mayApply = isCurrent; await refreshed.promise; if (isCurrent()) successes += 1; } }); });
    await answer("旧快照重跑");
    await act(async () => requests[2].pending.resolve({}));
    assert.equal(mayApply(), true);
    await render("d");
    assert.equal(action.message, null, "scope change hides successful old state immediately");
    assert.equal(mayApply(), false);
    await act(async () => refreshed.resolve());
    assert.equal(successes, 0);

    await act(async () => { void action.run({ ...input, onSuccess: async () => { throw new Error("fixture refresh failed"); } }); });
    await answer("旧快照重跑");
    await act(async () => requests[3].pending.resolve({}));
    assert.match(action.message!, /已重新入队，但刷新失败/);
    assert.equal(action.repair, null);

    await act(async () => { void action.run({ ...input, onSuccess: () => { successes += 1; } }); });
    await answer("旧快照重跑");
    await act(async () => root.render(null));
    await act(async () => requests[4].pending.resolve({}));
    assert.equal(successes, 0);

    await render("e");
    await act(async () => { void action.run(input); });
    await act(async () => root.render(<ConfirmDialogProvider><div /></ConfirmDialogProvider>));
    await answer("旧快照重跑");
    assert.equal(requests.length, 5, "unmount while awaiting confirmation cannot issue a request");
  } finally {
    await act(async () => root.unmount());
    api.resumeJob = originalResume;
    api.rerunJobCurrent = originalCurrent;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
