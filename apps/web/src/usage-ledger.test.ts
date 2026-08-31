import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  defaultCustomRange,
  readUsageLedgerCollapsed,
  shanghaiYmd,
  shiftShanghaiYmd,
  usageLedgerPageKey,
  usageLedgerPrefKey,
  usagePeriodLabel,
  writeUsageLedgerCollapsed,
} from "./usage-ledger.js";

test("Shanghai helpers keep custom defaults on a 7-day inclusive window", () => {
  const now = new Date("2026-08-19T10:00:00.000+08:00");
  assert.equal(shanghaiYmd(now), "2026-08-19");
  assert.equal(shiftShanghaiYmd("2026-08-19", -6), "2026-08-13");
  assert.deepEqual(defaultCustomRange(now), { from: "2026-08-13", to: "2026-08-19" });
});

test("period labels cover presets and custom range", () => {
  assert.equal(usagePeriodLabel("day"), "今日");
  assert.equal(usagePeriodLabel("week"), "近 7 日");
  assert.equal(usagePeriodLabel("month"), "近 30 日");
  assert.equal(usagePeriodLabel("custom"), "自定义");
});

test("usage board asks the dashboard usage API with period and optional custom range", () => {
  const source = readFileSync(new URL("./UsageLedgerBoard.tsx", import.meta.url), "utf8");
  assert.match(source, /api\.dashboardUsage\(/);
  assert.match(source, /period === "custom"/);
  assert.match(source, /from: customFrom/);
  assert.match(source, /to: customTo/);
  assert.match(source, /type="date"/);
  assert.match(source, /usage-ledger__date/);
});

test("usage ledger date fields do not reintroduce native picker style hooks", () => {
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.usage-ledger__date/);
  assert.match(styles, /\.usage-ledger__toggle/);
  assert.doesNotMatch(styles, /input\[type="date"\]/);
});

test("usage board source still wires cache columns and collapse toggle", () => {
  const source = readFileSync(new URL("./UsageLedgerBoard.tsx", import.meta.url), "utf8");
  assert.match(source, /缓存读/);
  assert.match(source, /缓存写/);
  assert.match(source, /cache_read_input_tokens/);
  assert.match(source, /usage-ledger__toggle/);
  assert.match(source, /readUsageLedgerCollapsed/);
});

test("collapse prefs default expanded and persist per user and page", () => {
  assert.equal(usageLedgerPageKey("global"), "global");
  assert.equal(usageLedgerPageKey("project", "p1"), "project:p1");
  assert.equal(usageLedgerPageKey("task", "p1", "c1"), "task:c1");
  assert.equal(usageLedgerPrefKey("user-1", "project:p1"), "deepsonar:usage-ledger:user-1:project:p1");

  const store = new Map<string, string>();
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  });
  try {
    assert.equal(readUsageLedgerCollapsed("user-1", "global"), false);
    writeUsageLedgerCollapsed("user-1", "global", true);
    assert.equal(readUsageLedgerCollapsed("user-1", "global"), true);
    assert.equal(readUsageLedgerCollapsed("user-2", "global"), false);
  } finally {
    if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("project usage lives on its own tab and not the task workbench", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
  const tasks = readFileSync(new URL("./pages/TasksPage.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./pages/ProjectUsagePage.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("./pages/ProjectLayout.tsx", import.meta.url), "utf8");
  assert.match(app, /path="usage"/);
  assert.match(app, /ProjectUsagePage/);
  assert.match(shell, /seg: "usage"/);
  assert.match(shell, /项目账本/);
  assert.match(layout, /to: "usage"/);
  assert.match(page, /UsageLedgerBoard scope="project"/);
  assert.doesNotMatch(tasks, /UsageLedgerBoard/);
});
