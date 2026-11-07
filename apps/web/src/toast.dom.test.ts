// #967 review P2: the pause machine must be driven by real DOM events and a
// fake clock, not by source-string assertions. Covers hover+focus overlap,
// focus leaving while hover holds, idempotent pause and duplicate refresh.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ToastHost, clearToasts, dismissToast, showToast } from "./toast.js";
import type { ShowToastOptions, ToastKind } from "./toast.js";

type Harness = Awaited<ReturnType<typeof setup>>;

const GLOBALS = ["window", "document", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;

function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ToastHost)));
  return { dom, root, container };
}

function teardown(harness: Harness) {
  act(() => harness.root.unmount());
  clearToasts();
  harness.dom.window.close();
  for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
}

const toasts = (harness: Harness) => [...harness.dom.window.document.querySelectorAll(".app-toast")];

const control = (harness: Harness, label: string) =>
  [...harness.dom.window.document.querySelectorAll(".app-toast-control")]
    .find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label) as HTMLElement | undefined;

/** Toast state lives outside React, so the store update must flush inside act. */
const show = (message: string, kind: ToastKind = "ok", options: ShowToastOptions = {}) => {
  let id: number | null = null;
  act(() => {
    id = showToast(message, kind, options);
  });
  return id;
};

/** Timer callbacks update React state, so the clock must advance inside act. */
const advance = (ms: number) => act(() => { mock.timers.tick(ms); });

/** React derives onMouseEnter/onMouseLeave from mouseover/mouseout pairs. */
function pointerOver(harness: Harness, target: Element) {
  act(() => {
    target.dispatchEvent(new harness.dom.window.MouseEvent("mouseover", {
      bubbles: true,
      relatedTarget: harness.dom.window.document.body,
    }));
  });
}
function pointerOut(harness: Harness, target: Element) {
  act(() => {
    // The portal container is document.body itself, so a body relatedTarget is
    // still "inside" the portal root and would not produce a leave event.
    target.dispatchEvent(new harness.dom.window.MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: null,
    }));
  });
}
function focus(harness: Harness, target: HTMLElement) {
  act(() => target.focus());
}
function blur(harness: Harness, target: HTMLElement) {
  act(() => target.blur());
}

test("hover holds the countdown until the pointer leaves", () => {
  const harness = setup();
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    show("已保存", "ok", { durationMs: 1000 });
    const [toast] = toasts(harness);
    assert.ok(toast, "toast is rendered");

    pointerOver(harness, toast);
    advance(5000);
    assert.equal(toasts(harness).length, 1, "a hovered toast must not expire");

    pointerOut(harness, toast);
    advance(999);
    assert.equal(toasts(harness).length, 1, "the remaining budget is respected");
    advance(2);
    assert.equal(toasts(harness).length, 0, "the countdown resumes after leaving");
  } finally {
    teardown(harness);
    mock.timers.reset();
  }
});

test("focus keeps holding after the pointer leaves, and blur releases it", () => {
  const harness = setup();
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    show("已保存", "ok", { durationMs: 1000, detail: "stack" });
    const [toast] = toasts(harness);
    const close = control(harness, "关闭提示");
    assert.ok(close, "the close control exists");

    pointerOver(harness, toast);
    focus(harness, close);
    // Leaving with the pointer must not resume: focus still holds the toast.
    pointerOut(harness, toast);
    advance(5000);
    assert.equal(toasts(harness).length, 1, "focus alone still holds the toast");
    assert.equal(harness.dom.window.document.activeElement, close, "the focused control is not removed");

    blur(harness, close);
    advance(1001);
    assert.equal(toasts(harness).length, 0, "releasing the last hold resumes the countdown");
  } finally {
    teardown(harness);
    mock.timers.reset();
  }
});

test("moving focus between controls inside a toast does not release the hold", () => {
  const harness = setup();
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    show("已保存", "ok", { durationMs: 1000, detail: "stack", action: { label: "重试", onClick: () => {} } });
    const copy = control(harness, "复制");
    const retry = control(harness, "重试");
    assert.ok(copy && retry);

    focus(harness, copy);
    advance(300);
    focus(harness, retry); // fires blur(copy) with relatedTarget inside the toast
    advance(5000);
    assert.equal(toasts(harness).length, 1, "internal focus moves keep the toast alive");
  } finally {
    teardown(harness);
    mock.timers.reset();
  }
});

test("pausing twice does not double-count the paused interval", () => {
  const harness = setup();
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    show("已保存", "ok", { durationMs: 1000 });
    const [toast] = toasts(harness);
    advance(400); // 600ms of budget left
    pointerOver(harness, toast);
    pointerOver(harness, toast); // idempotent: must not subtract again
    advance(3000);
    pointerOut(harness, toast);
    advance(599);
    assert.equal(toasts(harness).length, 1, "still 600ms of budget left");
    advance(2);
    assert.equal(toasts(harness).length, 0);
  } finally {
    teardown(harness);
    mock.timers.reset();
  }
});

test("a duplicate message while paused refreshes the budget without resuming", () => {
  const harness = setup();
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    show("同步失败", "error", { durationMs: 1000 });
    const [toast] = toasts(harness);
    advance(400); // 600ms of budget left
    pointerOver(harness, toast);

    // A shorter duplicate clamps the paused budget down to 300ms; it must not
    // resume the countdown, and the DOM key is unchanged so nothing would
    // re-trigger the hover hold if it did.
    show("同步失败", "error", { durationMs: 300 });
    assert.equal(toasts(harness).length, 1, "the duplicate merges into the same toast");
    advance(5000);
    assert.equal(toasts(harness).length, 1, "a paused toast must not resume on a duplicate");

    pointerOut(harness, toast);
    advance(299);
    assert.equal(toasts(harness).length, 1, "the budget was clamped to the new 300ms");
    advance(2);
    assert.equal(toasts(harness).length, 0);
  } finally {
    teardown(harness);
    mock.timers.reset();
  }
});

test("showToast returns a handle that dismissToast removes", () => {
  const harness = setup();
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const first = show("已保存", "ok", { durationMs: 1000 });
    const second = show("项目列表加载失败", "error", { sticky: true });
    assert.equal(typeof first, "number");
    assert.equal(typeof second, "number");
    assert.ok(second !== null);
    assert.equal(toasts(harness).length, 2);

    act(() => dismissToast(second));
    assert.equal(toasts(harness).length, 1, "a sticky failure can be cleared by its handle");
    advance(5000);
    assert.equal(toasts(harness).length, 0, "the remaining toast still expires on schedule");
  } finally {
    teardown(harness);
    mock.timers.reset();
  }
});

test("empty messages never create a toast", () => {
  const harness = setup();
  try {
    assert.equal(showToast("   ", "ok"), null);
    assert.equal(toasts(harness).length, 0);
  } finally {
    teardown(harness);
  }
});
