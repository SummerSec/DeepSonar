// #1057 回归：人工介入横幅在「0 条待处理、只有历史」时必须降噪并默认收起，
// 有真实待处理项时仍要用琥珀权重提示；tab 徽标必须使用诚实口径。
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HumanInterventionBanner } from "../HumanInterventionBanner.js";
import type { HumanInterventionItem, HumanInterventionPrefs } from "../human-messages.js";
import { TaskWorkbenchShell } from "./TaskWorkbenchShell.js";

const GLOBALS = ["window", "document", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;

/** jsdom 没有布局引擎：补上工作台 tab 条用到的观测与滚动 API。 */
function shimLayoutApis(win: JSDOM["window"]) {
  win.Element.prototype.scrollIntoView = () => {};
  if (!("ResizeObserver" in win)) {
    Object.defineProperty(win, "ResizeObserver", {
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      configurable: true,
      writable: true,
    });
  }
}

function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  shimLayoutApis(dom.window);
  const replacements: Record<string, unknown> = {
    ResizeObserver: dom.window.ResizeObserver,
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
  return {
    dom,
    container,
    render: (node: Parameters<typeof root.render>[0]) => act(() => root.render(node)),
    unmount: () => {
      act(() => root.unmount());
      dom.window.close();
      for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
    },
  };
}

const PREFS: HumanInterventionPrefs = { hideProcessed: true, bannerCollapsed: false, expandedIds: [], repliedIds: [], hiddenIds: [], messagesCollapsed: false };

function item(overrides: Partial<HumanInterventionItem>): HumanInterventionItem {
  return {
    node: { id: "node-1", title: "需要确认是否继续扫描", status: "waiting_human", node_type: "job", job_id: "job-1" },
    reason: "等待人工确认凭据环境",
    pending: true,
    jobId: "job-1",
    detailStatus: "loaded",
    detailVersionMatches: true,
    guidanceStatus: "available",
    ...overrides,
  } as unknown as HumanInterventionItem;
}

function renderBanner(harness: ReturnType<typeof setup>, items: HumanInterventionItem[], prefs: HumanInterventionPrefs = PREFS) {
  harness.render(
    createElement(HumanInterventionBanner, {
      items,
      prefs,
      onPrefsChange: () => {},
      onReply: () => {},
      onIgnore: () => {},
      onOpenFinding: () => {},
      onOpenJob: () => {},
    }),
  );
  return harness.container.querySelector("section") as HTMLElement;
}

test("只有历史、0 条待处理时横幅降噪并默认收起，但历史必须仍可展开", () => {
  const harness = setup();
  const history = item({ pending: false, node: { id: "node-2", title: "旧的介入", status: "succeeded", node_type: "job", job_id: "job-2" } as never });
  const banner = renderBanner(harness, [history], { ...PREFS, hideProcessed: false });
  try {
    assert.match(banner.className, /bg-white\/\[\.015\]/);
    assert.doesNotMatch(banner.className, /amber/);
    const toggle = banner.querySelector("button[aria-expanded]") as HTMLElement;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    // 关键：默认收起不等于禁止展开——点开后历史请求、Finding/Job 入口必须可达
    act(() => toggle.click());
    const reopened = harness.container.querySelector("section") as HTMLElement;
    assert.equal((reopened.querySelector("button[aria-expanded]") as HTMLElement).getAttribute("aria-expanded"), "true");
    assert.match(reopened.textContent ?? "", /旧的介入/);
  } finally {
    harness.unmount();
  }
});

test("存在待处理项时保留琥珀横幅并展开条目", () => {
  const harness = setup();
  const banner = renderBanner(harness, [item({})]);
  try {
    assert.match(banner.className, /bg-amber-400/);
    const toggle = banner.querySelector("button[aria-expanded]") as HTMLElement;
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.match(banner.textContent ?? "", /1 条待处理/);
  } finally {
    harness.unmount();
  }
});

test("tab 徽标使用 countLabel：一页满载显示 50+，未加载不显示 0", () => {
  const harness = setup();
  const tabs = [
    { key: "overview" as const, icon: () => null },
    { key: "facts" as const, countLabel: "50+", icon: () => null },
    { key: "findings" as const, icon: () => null },
  ];
  harness.render(createElement(TaskWorkbenchShell, { view: "overview", tabs, onViewChange: () => {}, header: null, children: createElement("div", null, "body") }));
  try {
    const buttons = [...harness.container.querySelectorAll('[role="tab"]')] as HTMLElement[];
    assert.equal(buttons.length, 3);
    assert.match(buttons[1].textContent ?? "", /50\+/);
    assert.doesNotMatch(buttons[2].textContent ?? "", /\d/);
  } finally {
    harness.unmount();
  }
});