import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackNotice } from "./FeedbackNotice";
import { useOperationFeedback } from "./use-operation-feedback";
import { clearToasts, showToast, ToastHost } from "./toast";

test("operation feedback keeps failures, replaces recovered results and drops obsolete owners", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let feedback!: ReturnType<typeof useOperationFeedback>;
  function Page({ scope }: { scope: string }) {
    feedback = useOperationFeedback(scope);
    return h(FeedbackNotice, { message: feedback.message, kind: feedback.kind, onDismiss: feedback.clear });
  }
  const render = (scope: string) => act(() => root.render(h(StrictMode, null, h(Page, { scope }), h(ToastHost))));
  const notices = () => dom.window.document.querySelectorAll(".app-feedback");
  const toasts = () => dom.window.document.querySelectorAll(".app-toast");
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    render("project-a");
    act(() => feedback.flash("已保存"));
    act(() => mock.timers.tick(3000));
    act(() => feedback.flash("permission denied", "error"));
    act(() => mock.timers.tick(20000));
    assert.match(notices()[0].textContent!, /permission denied/);
    assert.equal(notices()[0].getAttribute("role"), "alert");
    assert.equal(toasts().length, 1);
    assert.ok(toasts()[0].classList.contains("is-error"));
    assert.match(toasts()[0].textContent!, /操作失败/);
    const initialAlert = toasts()[0];
    act(() => feedback.flash("permission denied", "error"));
    assert.equal(toasts().length, 1, "repeated failure has one owner and one visible toast");
    assert.equal(toasts()[0], initialAlert, "background repeats must not reinsert and reannounce the same alert");
    act(() => feedback.flash("permission denied", "error", { detail: "new failure context" }));
    assert.match(toasts()[0].textContent!, /new failure context/, "a changed detail must update the failure");
    act(() => feedback.flash("保存成功"));
    assert.equal(notices()[0].getAttribute("role"), "status");
    assert.doesNotMatch(dom.window.document.body.textContent!, /permission denied/);
    act(() => mock.timers.tick(3201));
    assert.equal(notices().length, 0);
    assert.equal(toasts().length, 0);

    const oldFlash = feedback.flash;
    act(() => feedback.flash("旧项目错误", "error"));
    render("project-b");
    act(() => oldFlash("旧项目迟到错误", "error"));
    assert.equal(toasts().length, 0);
    assert.equal(notices().length, 0);
    render("project-a");
    act(() => oldFlash("首轮项目迟到错误", "error"));
    assert.equal(toasts().length, 0, "returning to a previous scope must not revive its old callback");
    act(() => feedback.flash("当前项目错误", "error"));
    const close = notices()[0].querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]');
    assert.ok(close);
    act(() => close.click());
    assert.equal(notices().length, 0);
    assert.equal(toasts().length, 0);
    const lateFlash = feedback.flash;
    act(() => root.render(h(ToastHost)));
    act(() => lateFlash("卸载后迟到错误", "error"));
    assert.equal(toasts().length, 0);
  } finally {
    act(() => root.unmount());
    clearToasts();
    mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("global errors persist by default and background time does not consume a timed notice", () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    act(() => root.render(h(ToastHost)));
    act(() => showToast("连接失败", "error"));
    act(() => mock.timers.tick(60000));
    assert.equal(dom.window.document.querySelectorAll(".app-toast").length, 1);
    act(() => clearToasts());
    act(() => showToast("导出开始", "ok", { durationMs: 1000 }));
    act(() => mock.timers.tick(400));
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    act(() => mock.timers.tick(10000));
    assert.equal(dom.window.document.querySelectorAll(".app-toast").length, 1);
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    act(() => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    act(() => mock.timers.tick(599));
    assert.equal(dom.window.document.querySelectorAll(".app-toast").length, 1);
    act(() => mock.timers.tick(2));
    assert.equal(dom.window.document.querySelectorAll(".app-toast").length, 0);
  } finally {
    act(() => root.unmount());
    clearToasts();
    mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
