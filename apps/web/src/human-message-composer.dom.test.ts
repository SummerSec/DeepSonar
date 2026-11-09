import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { api, type CanvasNode } from "./api.js";
import { listHumanInterventions, openHumanInterventionForJob } from "./human-messages.js";
import { HumanInterventionDetailStore, mergeHumanInterventionDetails } from "./human-intervention-details.js";

test("a reply saved after leaving and returning to a task cannot close its new draft", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1" });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const { HumanMessageComposer } = await import("./HumanMessageComposer.js");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let save!: (value: Awaited<ReturnType<typeof api.createCanvasMessage>>) => void;
  const saved = new Promise<Awaited<ReturnType<typeof api.createCanvasMessage>>>(resolve => { save = resolve; });
  const createMessage = mock.method(api, "createCanvasMessage", () => saved);
  const target = { id: "node-a", job_id: "job-a", node_type: "job", status: "running", title: "运行 A", body_json: {} } as CanvasNode;
  let oldCallback = 0;
  let newCallback = 0;
  const render = (onSent: () => void) => act(() => root.render(createElement(HumanMessageComposer, {
    canvasId: "canvas-a", projectId: "project-a", selectedNode: target,
    onClose: () => {}, onSent,
  })));
  const type = (value: string) => {
    const textarea = container.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const send = () => act(() => {
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "发送消息")!;
    assert.equal(button.disabled, false);
    button.click();
  });
  try {
    render(() => { oldCallback++; });
    type("第一条已授权发送的回复");
    send();
    assert.equal(createMessage.mock.callCount(), 1);
    act(() => root.render(null)); // Leave A, then return with a fresh composer instance.
    render(() => { newCallback++; });
    type("返回 A 后尚未发送的新草稿");
    await act(async () => {
      save({
        id: "saved-a", canvas_id: "canvas-a", human_node_id: "human-a",
        target_kind: "job", target_node_id: "node-a", target_job_id: "job-a",
        body: "第一条已授权发送的回复", status: "planned", attachments: [],
        planned_at: "2026-11-09T06:00:00.000Z", delivered_at: null,
        acknowledged_at: null, ack_summary: null, error: null,
      });
      await saved;
    });
    assert.equal(oldCallback, 0, "old saved message must not call the unmounted composer's owner");
    assert.equal(newCallback, 0);
    assert.equal(container.querySelector("textarea")!.value, "返回 A 后尚未发送的新草稿");
    await act(async () => { send(); await saved; });
    assert.equal(newCallback, 1, "the current mounted composer can still report a successful send");

    act(() => root.render(null));
    const requests = Array.from({ length: 13 }, (_, index): CanvasNode => ({
      ...target, id: `human-${index}`, job_id: `job-${index}`, node_type: "human", status: "open",
      updated_at: `2026-11-09T06:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const selected = openHumanInterventionForJob(requests, "job-0")!;
    const preview = listHumanInterventions(requests).map(item => item.node);
    const waitingTarget = { ...target, job_id: "job-0", status: "waiting_human" };
    const renderWaiting = (intervention: ReturnType<typeof listHumanInterventions>[number] | null) => act(() => root.render(createElement(HumanMessageComposer, {
      canvasId: "canvas-a", projectId: "project-a", selectedNode: waitingTarget, intervention,
      onClose: () => {}, onSent: () => { newCallback++; },
    })));
    const sendDisabled = () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "发送消息")!.disabled;
    renderWaiting(null);
    type("第十三条请求的草稿");
    assert.equal(sendDisabled(), true, "a waiting Job without its request must never bypass the guard");
    const store = new HumanInterventionDetailStore(async (_canvasId, id) => ({
      ...requests.find(item => item.id === id)!, body_json: { reason: `完整问题 ${id}`, guidance: {
        question: "是否继续？", required_action: "确认范围", reply_instructions: "回复范围", after_reply: "重新核验准入",
      } },
    }));
    store.refresh("canvas-a", preview, selected);
    const currentItem = () => mergeHumanInterventionDetails(listHumanInterventions([selected]), store.getSnapshot().entries)[0]!;
    renderWaiting(currentItem());
    assert.equal(sendDisabled(), true, "L1 is still loading");
    await new Promise<void>(resolve => setImmediate(resolve));
    store.refresh("canvas-a", [...preview].reverse(), selected);
    renderWaiting(currentItem());
    assert.match(container.textContent ?? "", /完整问题 human-0/);
    assert.equal(sendDisabled(), false, "the pinned thirteenth request is verified after preview reordering");
    renderWaiting({ ...currentItem(), detailVersionMatches: false });
    assert.equal(sendDisabled(), true, "a changed request version disables the existing draft");
    assert.equal(createMessage.mock.callCount(), 2, "guarded drafts never reach the message API");
  } finally {
    act(() => root.unmount());
    createMessage.mock.restore();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
