// #967: source-level contract for the unified feedback behaviour. The repo has
// no DOM test runner, so component wiring is asserted against the source the
// same way settings-save-feedback.test.ts already does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const toast = read("./toast.tsx");
const model = read("./toast-model.ts");
const hook = read("./use-flash-message.ts");
const ui = read("./ui.tsx");
const styles = read("./styles.css");
const settings = read("./SettingsPanel.tsx");
const projects = read("./pages/ProjectsPage.tsx");
const finding = read("./FindingDetailPanel.tsx");

test("toast host announces severity per item and exposes real controls", () => {
  assert.match(toast, /role=\{aria\.role\}/);
  assert.match(toast, /aria-live=\{aria\.live\}/);
  assert.match(toast, /aria-atomic="true"/);
  assert.match(toast, /aria-label="关闭提示"/);
  assert.match(toast, /dismissToast\(toast\.id\)/);
  assert.match(toast, /<details className="app-toast-detail">/, "long detail is collapsed behind a disclosure");
  assert.match(toast, /复制/, "technical detail can be copied");
  assert.match(toast, /toast\.action\?\.onClick\(\)/, "recovery actions are wired");
  // #967 review P2: hover and focus are independent holds, so the host must
  // name the reason and must not release focus when it moves inside the toast.
  assert.match(toast, /pauseToast\(toast\.id, "hover"\)/);
  assert.match(toast, /resumeToast\(toast\.id, "hover"\)/);
  assert.match(toast, /pauseToast\(toast\.id, "focus"\)/);
  assert.match(toast, /resumeToast\(toast\.id, "focus"\)/);
  assert.match(toast, /event\.currentTarget\.contains\(next\)/, "internal focus moves must keep the hold");
  assert.match(toast, /export type ToastHold = "hover" \| "focus"/);
  assert.match(toast, /addToast\(items, incoming\)/, "duplicate messages are merged by the model");
  assert.match(toast, /for \(const id of \[\.\.\.timers\.keys\(\)\]\) forget\(id\)/, "timers are cleared on unmount");
  assert.match(toast, /for \(const id of \[\.\.\.holds\.keys\(\)\]\) forget\(id\)/, "holds are cleared on unmount");
  assert.doesNotMatch(toast, /window\.setTimeout\(\(\) => \{\s*items = items\.filter/, "no untracked one-shot timers");
});

test("toast model owns dedupe, the visible cap and the aria mapping", () => {
  assert.match(model, /export const MAX_VISIBLE_TOASTS/);
  assert.match(model, /export const TOAST_DURATIONS/);
  assert.match(model, /export function toastAria/);
  assert.match(model, /kind === "error"[\s\S]*?assertive/);
  assert.match(model, /export function addToast/);
  assert.match(model, /Number\(left\.sticky\) - Number\(right\.sticky\)/, "sticky toasts are evicted last");
});

test("toast surfaces are clickable and token-driven", () => {
  assert.match(styles, /\.app-toast \{[^}]*pointer-events: auto/s);
  assert.match(styles, /\.app-toast \{[^}]*var\(--toast-ok-bg\)/s);
  assert.match(styles, /\.app-toast\.is-warn/);
  assert.match(styles, /\.app-toast\.is-error/);
  assert.match(styles, /\.app-toast-control:focus-visible/);
});

test("HelpTip closes on Escape and keeps the trigger focusable", () => {
  assert.match(ui, /onKeyDown=\{closeFromKeyboard\}/);
  assert.match(ui, /event\.key !== "Escape"/);
  assert.match(ui, /event\.preventDefault\(\)/);
  // The existing hover/focus/portal behaviour must not regress.
  assert.match(ui, /setTimeout\(\(\) => setOpen\(false\), 80\)/);
  assert.match(ui, /onMouseEnter=\{cancelClose\}/);
  assert.match(ui, /role="tooltip"/);
});

test("pages share one flash owner instead of ad-hoc timers", () => {
  for (const [name, source] of [["SettingsPanel", settings], ["ProjectsPage", projects], ["FindingDetailPanel", finding]] as const) {
    assert.match(source, /useFlashMessage\(/, `${name} must use the shared flash hook`);
    assert.doesNotMatch(
      source,
      /setTimeout\(\(\) => setMsg\(null\)/,
      `${name} must not keep its own message timer (the previous timer cancelled the newer message)`,
    );
  }
  assert.match(hook, /clearTimeout\(timer\.current\)/, "a new flash cancels the previous timer");
  assert.match(hook, /useEffect\(\(\) => stop, \[stop\]\)/, "the timer is cleared on unmount");
  assert.match(hook, /durationMs <= 0/, "blocking failures can stay until the next action");
});

test("blocking failures remain readable and offer a next step", () => {
  assert.match(settings, /flashMessage\(m, \{ durationMs: 0 \}\)/);
  assert.match(projects, /role="alert"/);
  assert.match(projects, /重试/);
  assert.match(projects, /sticky: true/);
  assert.match(projects, /detail/);
});
