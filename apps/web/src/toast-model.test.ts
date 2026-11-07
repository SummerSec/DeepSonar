// #967: the toast state machine is pure so dedupe, the visible cap and the
// aria mapping can be tested without a DOM.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VISIBLE_TOASTS,
  TOAST_DURATIONS,
  addToast,
  inferToastKind,
  remainingLifetime,
  removeToast,
  toastAria,
  type ToastItem,
} from "./toast-model.js";

const item = (id: number, overrides: Partial<ToastItem> = {}): ToastItem => ({
  id,
  message: `message-${id}`,
  kind: "ok",
  sticky: false,
  durationMs: TOAST_DURATIONS.ok,
  ...overrides,
});

test("severity inference separates failures, warnings and success", () => {
  assert.equal(inferToastKind("保存失败：字段必填"), "error");
  assert.equal(inferToastKind("项目列表加载失败"), "error");
  assert.equal(inferToastKind("部分设置未生效"), "warn");
  assert.equal(inferToastKind("注意：该操作不可撤销"), "warn");
  assert.equal(inferToastKind("已保存"), "ok");
});

test("only failures are announced assertively", () => {
  assert.deepEqual(toastAria("error"), { role: "alert", live: "assertive" });
  assert.deepEqual(toastAria("warn"), { role: "status", live: "polite" });
  assert.deepEqual(toastAria("ok"), { role: "status", live: "polite" });
});

test("failures stay longer than success", () => {
  assert.ok(TOAST_DURATIONS.error > TOAST_DURATIONS.ok);
  assert.ok(TOAST_DURATIONS.warn > TOAST_DURATIONS.ok);
  assert.ok(TOAST_DURATIONS.error > TOAST_DURATIONS.warn);
});

test("an identical toast is merged instead of stacked", () => {
  const first = addToast([], item(1, { kind: "error", message: "保存失败" }));
  assert.equal(first.items.length, 1);
  assert.equal(first.replacedId, null);

  const second = addToast(first.items, item(2, { kind: "error", message: "保存失败" }));
  assert.equal(second.items.length, 1, "the same failure must not appear twice");
  assert.equal(second.replacedId, 1, "the existing toast is refreshed, not duplicated");
  assert.equal(second.items[0]?.id, 1);
});

test("a merged toast keeps the strongest sticky/detail/action", () => {
  const existing = item(1, { kind: "error", message: "保存失败", detail: "stack: boom" });
  const incoming = item(2, {
    kind: "error",
    message: "保存失败",
    sticky: true,
    action: { label: "重试", onClick: () => {} },
  });
  const { items } = addToast([existing], incoming);
  assert.equal(items[0]?.sticky, true);
  assert.equal(items[0]?.detail, "stack: boom", "an existing detail is not dropped");
  assert.equal(items[0]?.action?.label, "重试");
});

test("the stack is capped and transient toasts are evicted before blocking ones", () => {
  let items: ToastItem[] = [item(1, { sticky: true, kind: "error" })];
  for (let id = 2; id <= MAX_VISIBLE_TOASTS + 2; id += 1) {
    items = addToast(items, item(id)).items;
  }
  assert.equal(items.length, MAX_VISIBLE_TOASTS);
  assert.ok(items.some((entry) => entry.id === 1), "a blocking error survives a burst of successes");
  assert.ok(!items.some((entry) => entry.id === 2), "the oldest transient toast is dropped first");
});

test("removeToast drops exactly one entry", () => {
  const items = [item(1), item(2), item(3)];
  assert.deepEqual(removeToast(items, 2).map((entry) => entry.id), [1, 3]);
  assert.deepEqual(removeToast(items, 99).map((entry) => entry.id), [1, 2, 3]);
});

test("pausing never yields a negative remaining lifetime", () => {
  assert.equal(remainingLifetime(3200, 0), 3200);
  assert.equal(remainingLifetime(3200, 1200), 2000);
  assert.equal(remainingLifetime(3200, 9000), 0);
});
