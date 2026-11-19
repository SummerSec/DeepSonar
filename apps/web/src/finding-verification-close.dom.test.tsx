import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { api, type AuthMe } from "./api";
import { ApiRequestError } from "./login-error";
import { FindingVerificationClose } from "./FindingVerificationClose";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";

test("人工无定论按钮按权限、原因和真实确认发送 CAS，409 刷新且不重发", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, crypto: dom.window.crypto, IS_REACT_ACT_ENVIRONMENT: true };
  Object.defineProperty(dom.window.crypto, "randomUUID", { value: undefined, configurable: true });
  const saved = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const originalAuth = api.authMe;
  const originalClose = api.closeFindingInconclusive;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const control = { verify_status: "needs_human", subject_revision: "target@frozen", latest_round_id: "00000000-0000-4000-8000-000000000001" };
  let scopes = ["jobs:control"];
  let status = "needs_human";
  let hasControl = true;
  let findingId = "finding-a";
  let changed = 0;
  const calls: Array<Parameters<typeof api.closeFindingInconclusive>> = [];
  api.authMe = async () => ({ authenticated: true, auth_required: true,
    actor: { type: "api_token", name: "operator", project_id: "project-a", scopes } }) as AuthMe;
  api.closeFindingInconclusive = async (...args) => {
    calls.push(args);
    throw new ApiRequestError({ method: "PATCH", path: "/findings/finding-a/verify-status", status: 409,
      errorCode: "FINDING_VERIFICATION_STALE", serverMessage: "验证轮次已变化，请刷新后决定" });
  };
  const render = (key: string) => act(async () => root.render(<ConfirmDialogProvider>
    <FindingVerificationClose key={key} findingId={findingId} control={hasControl ? { ...control, verify_status: status } : null} onChanged={async () => { changed++; }} />
  </ConfirmDialogProvider>));
  try {
    await render("readonly");
    assert.equal(dom.window.document.querySelector("button"), null, "jobs:control 不授予 findings:write");
    const authorizedMe = api.authMe;
    api.authMe = async () => { throw new Error("authentication unavailable"); };
    await render("auth-failed");
    assert.equal(dom.window.document.querySelector("button"), null, "认证读取失败不能显示写操作");
    assert.equal(calls.length, 0);
    api.authMe = authorizedMe;
    scopes = ["findings:write"];
    hasControl = false;
    await render("detached");
    assert.equal(dom.window.document.querySelector("button"), null, "无有效画布的只读详情没有结束按钮");
    hasControl = true;
    await render("operator");
    const button = dom.window.document.querySelector("button")!;
    assert.equal(button.textContent, "以无定论结束");
    assert.equal(button.disabled, true);
    const textarea = dom.window.document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "授权设备暂不可用");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(button.disabled, false);
    const getRandomValues = dom.window.crypto.getRandomValues.bind(dom.window.crypto);
    Object.defineProperty(dom.window.crypto, "getRandomValues", {
      value: () => { throw new Error("random fixture failure"); }, configurable: true,
    });
    await act(async () => button.click());
    assert.equal(button.disabled, false, "生成请求编号失败后按钮必须恢复");
    assert.equal(calls.length, 0);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /random fixture failure/);
    Object.defineProperty(dom.window.crypto, "getRandomValues", { value: getRandomValues, configurable: true });
    await act(async () => { button.click(); button.click(); });
    const dialog = dom.window.document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    const confirm = [...dialog.querySelectorAll("button")].find((candidate) => candidate.textContent === "以无定论结束")!;
    await act(async () => confirm.click());
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "finding-a");
    assert.deepEqual(calls[0][1].expected, control);
    assert.equal(calls[0][1].reason, "授权设备暂不可用");
    assert.match(calls[0][1].mutation_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(changed, 1);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /验证轮次已变化/);

    // 响应丢失后的幂等决定只能绑定原 Finding。原确认框在切换后也不能发送。
    api.closeFindingInconclusive = async (...args) => { calls.push(args); throw new Error("response lost"); };
    await act(async () => button.click());
    await act(async () => [...dom.window.document.querySelector('[role="dialog"]')!.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "以无定论结束")!.click());
    assert.equal(calls.length, 2);
    assert.equal(textarea.disabled, true);
    await act(async () => button.click());
    findingId = "finding-b";
    await render("operator");
    await act(async () => [...dom.window.document.querySelector('[role="dialog"]')!.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "以无定论结束")!.click());
    assert.equal(calls.length, 2, "切换后旧确认不能发送请求");
    const newTextarea = dom.window.document.querySelector("textarea")!;
    assert.equal(newTextarea.value, "");
    assert.equal(newTextarea.disabled, false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(newTextarea, "新 Finding 决定");
      newTextarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const newButton = dom.window.document.querySelector("button")!;
    await act(async () => newButton.click());
    await act(async () => [...dom.window.document.querySelector('[role="dialog"]')!.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "以无定论结束")!.click());
    assert.equal(calls.length, 3);
    assert.equal(calls[2][0], "finding-b");
    assert.notEqual(calls[2][1].mutation_id, calls[1][1].mutation_id);
    control.latest_round_id = "00000000-0000-4000-8000-000000000002";
    await render("operator");
    assert.equal(dom.window.document.querySelector("textarea")!.value, "", "同 Finding 新轮次必须清除旧决定");
    status = "inconclusive";
    await render("finished");
    assert.equal(dom.window.document.querySelector("button"), null);
  } finally {
    await act(async () => root.unmount());
    api.authMe = originalAuth;
    api.closeFindingInconclusive = originalClose;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
