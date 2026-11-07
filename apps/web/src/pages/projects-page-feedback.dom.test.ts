// #967 review P2: a sticky load-failure toast must not outlive the page's own
// recovery path. Regression: initial failure -> inline retry -> success must
// remove both the inline alert and the viewport-fixed toast.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { api, type Project } from "../api";
import { ToastHost, clearToasts } from "../toast";
import { ProjectsPage } from "./ProjectsPage";

const GLOBALS = ["window", "document", "HTMLElement", "Element", "Node", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "fixture-project",
  description: "",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

test("a successful inline retry clears the sticky load-failure toast", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const original = api.projects;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  // The error toast is also role="alert" and is portaled to document.body, so
  // the inline banner must be queried inside the page container.
  const alerts = () => [...container.querySelectorAll('[role="alert"]')];
  const toasts = () => [...dom.window.document.querySelectorAll(".app-toast")];
  const toastText = () => toasts().map((node) => node.textContent ?? "").join(" | ");

  try {
    let attempt = 0;
    api.projects = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("fixture list unavailable");
      return [project];
    };

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(ToastHost), createElement(ProjectsPage)));
    });
    await act(async () => { await Promise.resolve(); });

    assert.equal(alerts().length, 1, "the inline failure banner is shown");
    assert.match(toastText(), /项目列表加载失败/, "a viewport-fixed copy is shown");
    assert.match(toastText(), /fixture list unavailable/, "the technical detail is available");

    const retry = [...alerts()[0].querySelectorAll("button")].find((node) => node.textContent?.includes("重试"));
    assert.ok(retry, "the inline banner offers a retry");

    await act(async () => {
      retry.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    assert.equal(attempt, 2, "the retry actually reloaded");
    assert.equal(alerts().length, 0, "the inline failure banner is cleared on success");
    assert.equal(toasts().length, 0, "the sticky failure toast is cleared on success");
  } finally {
    act(() => root.unmount());
    // Unmount before closing the DOM: a still-mounted ToastHost would schedule a
    // state update against a disposed window.
    act(() => root.unmount());
    clearToasts();
    api.projects = original;
    dom.window.close();
    for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  }
});

test("unmounting the page clears its sticky failure toast", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const original = api.projects;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const toasts = () => [...dom.window.document.querySelectorAll(".app-toast")];

  try {
    api.projects = async () => { throw new Error("fixture list unavailable"); };
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(ToastHost), createElement(ProjectsPage)));
    });
    await act(async () => { await Promise.resolve(); });
    assert.equal(toasts().length, 1, "the failure toast is shown");

    // Unmount ONLY the page: ToastHost stays mounted, which is how the real app
    // behaves (it is a sibling of the router outlet). Unmounting the root would
    // hide the store leak because the portal disappears with it.
    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(ToastHost)));
    });
    assert.equal(toasts().length, 0, "leaving the page must not leave a fixed toast behind");
  } finally {
    // Unmount before closing the DOM: a still-mounted ToastHost would schedule a
    // state update against a disposed window.
    act(() => root.unmount());
    clearToasts();
    api.projects = original;
    dom.window.close();
    for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  }
});

test("a load failure that lands after the page unmounts does not create a toast", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const original = api.projects;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const toasts = () => [...dom.window.document.querySelectorAll(".app-toast")];

  try {
    // Deferred so the request is still pending when the page unmounts.
    let reject!: (reason: Error) => void;
    const pending = new Promise<Project[]>((_, no) => { reject = no; });
    api.projects = () => pending;

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(ToastHost), createElement(ProjectsPage)));
    });
    assert.equal(toasts().length, 0, "nothing has failed yet");

    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(ToastHost)));
    });
    await act(async () => {
      reject(new Error("late fixture failure"));
      await Promise.resolve();
    });

    assert.equal(
      toasts().length,
      0,
      "a failure that lands after navigation must not resurrect the sticky toast",
    );
  } finally {
    // Unmount before closing the DOM: a still-mounted ToastHost would schedule a
    // state update against a disposed window.
    act(() => root.unmount());
    clearToasts();
    api.projects = original;
    dom.window.close();
    for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  }
});

test("the page still loads under StrictMode's effect replay", async () => {
  // The real entry point (main.tsx) wraps the app in <StrictMode>, which replays
  // every effect as setup -> cleanup -> setup in development. The unmount guard
  // must not survive that replay, or the page stays on its loading state.
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const original = api.projects;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  let calls = 0;

  try {
    api.projects = async () => {
      calls += 1;
      return [project];
    };

    await act(async () => {
      root.render(createElement(StrictMode, null,
        createElement(MemoryRouter, null, createElement(ToastHost), createElement(ProjectsPage))));
    });

    assert.ok(calls >= 1, "the replay still issues a request");
    assert.equal(
      container.textContent?.includes("fixture-project"),
      true,
      "after the StrictMode replay the page must leave loading and render the list",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".app-toast").length,
      0,
      "a successful load raises no toast",
    );
  } finally {
    act(() => root.unmount());
    clearToasts();
    api.projects = original;
    dom.window.close();
    for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  }
});

test("a StrictMode replay followed by a real unmount still creates no toast", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const original = api.projects;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const toasts = () => [...dom.window.document.querySelectorAll(".app-toast")];

  try {
    let reject!: (reason: Error) => void;
    const pending = new Promise<Project[]>((_, no) => { reject = no; });
    api.projects = () => pending;

    await act(async () => {
      root.render(createElement(StrictMode, null,
        createElement(MemoryRouter, null, createElement(ToastHost), createElement(ProjectsPage))));
    });
    assert.equal(toasts().length, 0, "nothing has failed yet");

    // Drop only the page; ToastHost stays mounted exactly like the real app.
    act(() => {
      root.render(createElement(StrictMode, null, createElement(MemoryRouter, null, createElement(ToastHost))));
    });
    await act(async () => {
      reject(new Error("late fixture failure"));
      await Promise.resolve();
    });
    assert.equal(toasts().length, 0, "a late failure after a replay and unmount must stay inert");
  } finally {
    act(() => root.unmount());
    clearToasts();
    api.projects = original;
    dom.window.close();
    for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  }
});
