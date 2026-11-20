import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { api, type CanvasNode, type CreateCanvasHumanMessage } from "./api.js";
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
  let sendError: Error | null = null;
  const createMessage = mock.method(api, "createCanvasMessage", (_canvasId: string, _message: CreateCanvasHumanMessage) => {
    if (sendError) return Promise.reject(sendError);
    return saved;
  });
  let loadRequest!: (value: Awaited<ReturnType<typeof api.job>>) => void;
  const requestLoaded = new Promise<Awaited<ReturnType<typeof api.job>>>(resolve => { loadRequest = resolve; });
  let requestResult = requestLoaded;
  const readJob = mock.method(api, "job", () => requestResult);
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
    assert.equal(readJob.mock.callCount(), 0, "ordinary running messages do not read or answer a human request");
    assert.deepEqual(createMessage.mock.calls[0]!.arguments[1].target, { kind: "job", node_id: "node-a" });
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
    assert.equal(sendDisabled(), true, "canvas detail alone cannot authorize a durable request reply");
    const currentDetail = {
      job: { id: "job-0", canvas_id: "canvas-a", status: "waiting_human" },
      human_request: { event_id: "request-a", current: true, payload: { reason: "当前持久请求的完整问题" } },
      human_continuation: { id: "request-a", revision: 3, status: "open" },
    } as Awaited<ReturnType<typeof api.job>>;
    await act(async () => {
      loadRequest(currentDetail);
      await requestLoaded;
    });
    assert.match(container.textContent ?? "", /当前持久请求的完整问题/);
    assert.equal(sendDisabled(), false, "the current request and revision are loaded before sending");
    renderWaiting({ ...currentItem(), detailStatus: "error", detailVersionMatches: false, detailError: "画布详情暂时不可读" });
    assert.equal(sendDisabled(), true);
    assert.match(container.textContent ?? "", /画布详情暂时不可读/);
    assert.ok([...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "重试读取"));
    renderWaiting({ ...currentItem(), detailVersionMatches: false });
    assert.equal(sendDisabled(), true, "a changed request version disables the existing draft");
    assert.equal(createMessage.mock.callCount(), 2, "guarded drafts never reach the message API");
    renderWaiting(currentItem());
    await act(async () => { send(); await saved; });
    assert.deepEqual(createMessage.mock.calls[2]!.arguments[1].target, {
      kind: "request", request_id: "request-a", expected_revision: 3,
    }, "waiting_human replies must carry the durable request identity, not a generic Job target");
    assert.equal(createMessage.mock.calls[2]!.arguments[1].body, "第十三条请求的草稿");

    // Missing canvas preview must not hide a valid durable request or make the user guess its ID.
    act(() => root.render(null));
    requestResult = Promise.resolve(currentDetail);
    await act(async () => { renderWaiting(null); await requestResult; });
    type("无需画布摘要也能回复");
    assert.equal(sendDisabled(), false);
    assert.match(container.textContent ?? "", /当前持久请求的完整问题/);

    for (const detail of [
      { ...currentDetail, human_continuation: null },
      { ...currentDetail, human_continuation: { ...currentDetail.human_continuation!, status: "answered" as const } },
      { ...currentDetail, human_request: { ...currentDetail.human_request!, current: false } },
      { ...currentDetail, human_request: { ...currentDetail.human_request!, event_id: "different-request" } },
      { ...currentDetail, job: { ...currentDetail.job, canvas_id: "different-canvas" } },
    ]) {
      act(() => root.render(null));
      requestResult = Promise.resolve(detail);
      await act(async () => { renderWaiting(null); await requestResult; });
      type("不可发送的草稿");
      assert.equal(sendDisabled(), true, "missing, processed, historical or unrelated requests cannot be answered");
    }

    act(() => root.render(null));
    requestResult = Promise.resolve(currentDetail).then(() => { throw new Error("请求读取失败"); });
    await act(async () => { renderWaiting(null); await requestResult.catch(() => {}); });
    type("读取失败仍保留草稿");
    assert.equal(sendDisabled(), true);
    assert.match(container.textContent ?? "", /请求读取失败/);
    requestResult = Promise.resolve(currentDetail);
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "重试读取")!.click();
      await requestResult;
    });
    assert.equal(sendDisabled(), false);
    assert.equal(container.querySelector("textarea")!.value, "读取失败仍保留草稿");
    assert.equal(createMessage.mock.callCount(), 3, "loading, blocked and retry actions never send a message");

    act(() => root.render(null));
    let finishOldRead!: (detail: typeof currentDetail) => void;
    const oldRead = new Promise<typeof currentDetail>(resolve => { finishOldRead = resolve; });
    requestResult = oldRead;
    renderWaiting(null);
    act(() => root.render(null));
    requestResult = Promise.resolve({ ...currentDetail,
      human_request: { ...currentDetail.human_request!, event_id: "request-b" },
      human_continuation: { ...currentDetail.human_continuation!, id: "request-b", revision: 7 },
    });
    await act(async () => { renderWaiting(null); await requestResult; });
    type("重新打开后回复当前问题");
    await act(async () => { finishOldRead(currentDetail); await oldRead; });
    await act(async () => { send(); await saved; });
    assert.deepEqual(createMessage.mock.calls[3]!.arguments[1].target, {
      kind: "request", request_id: "request-b", expected_revision: 7,
    }, "an old request read cannot overwrite the current composer's target");

    act(() => root.render(null));
    requestResult = Promise.resolve({ ...currentDetail,
      human_request: { ...currentDetail.human_request!, event_id: "request-b" },
      human_continuation: { ...currentDetail.human_continuation!, id: "request-b", revision: 7 },
    });
    await act(async () => { renderWaiting(null); await requestResult; });
    type("重新打开后回复当前问题");
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    act(() => radios[0]!.click());
    let finishNewRead!: (detail: typeof currentDetail) => void;
    requestResult = new Promise(resolve => { finishNewRead = resolve; });
    act(() => radios[1]!.click());
    assert.equal(sendDisabled(), true, "returning from Hub must wait for a fresh read, not reuse a cached request");
    const nextDetail = { ...currentDetail,
      human_request: { ...currentDetail.human_request!, event_id: "request-b" },
      human_continuation: { ...currentDetail.human_continuation!, id: "request-b", revision: 8 },
    };
    await act(async () => { finishNewRead(nextDetail); await requestResult; });
    const confirmDraft = () => act(() => {
      [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "确认用此草稿回复当前问题")!.click();
    });
    assert.equal(sendDisabled(), true, "a refreshed revision must not silently rebind the draft");
    assert.equal(createMessage.mock.callCount(), 4);
    confirmDraft();
    sendError = new Error("HUMAN_REQUEST_CHANGED: 请求已变化");
    await act(async () => { send(); await saved; });
    assert.match(container.textContent ?? "", /HUMAN_REQUEST_CHANGED/);
    assert.equal(container.querySelector("textarea")!.value, "重新打开后回复当前问题");
    requestResult = Promise.resolve({ ...nextDetail,
      human_continuation: { ...nextDetail.human_continuation!, revision: 9 },
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "重新读取当前请求")!.click();
      await requestResult;
    });
    assert.equal(container.querySelector("textarea")!.value, "重新打开后回复当前问题");
    assert.equal(sendDisabled(), true);
    assert.equal(createMessage.mock.callCount(), 5, "rereading never submits or rebinds the draft without confirmation");
    confirmDraft();
    sendError = null;
    await act(async () => { send(); await saved; });
    assert.deepEqual(createMessage.mock.calls[5]!.arguments[1].target, {
      kind: "request", request_id: "request-b", expected_revision: 9,
    }, "after a stale revision is rejected, the retained draft can answer the freshly read request");

    act(() => root.render(null));
    requestResult = Promise.resolve(currentDetail);
    await act(async () => { renderWaiting(currentItem()); await requestResult; });
    type("写给问题 A 的草稿");
    const replacement = { ...currentDetail,
      human_request: { ...currentDetail.human_request!, event_id: "request-c", payload: { reason: "新的问题 B" } },
      human_continuation: { ...currentDetail.human_continuation!, id: "request-c", revision: 0 },
    };
    requestResult = Promise.resolve(replacement);
    const refreshedItem = { ...currentItem(), node: { ...currentItem().node, updated_at: "2026-11-20T07:00:00.000Z" } };
    await act(async () => { renderWaiting(refreshedItem); await requestResult; });
    assert.match(container.textContent ?? "", /新的问题 B/);
    assert.equal(container.querySelector("textarea")!.value, "写给问题 A 的草稿");
    assert.equal(sendDisabled(), true, "a new request on the same Job must never inherit the previous request's answer");
    act(() => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "发送消息")!.click());
    renderWaiting(refreshedItem);
    assert.equal(sendDisabled(), true, "rerendering the new request cannot implicitly confirm the old draft");
    assert.equal(createMessage.mock.callCount(), 6, "no reply API call is allowed before confirming the new question");
    confirmDraft();
    assert.equal(createMessage.mock.callCount(), 6, "confirmation alone must not send anything");
    await act(async () => { send(); await saved; });
    assert.deepEqual(createMessage.mock.calls[6]!.arguments[1].target, {
      kind: "request", request_id: "request-c", expected_revision: 0,
    });
    assert.equal(createMessage.mock.calls[6]!.arguments[1].body, "写给问题 A 的草稿");
  } finally {
    act(() => root.unmount());
    createMessage.mock.restore();
    readJob.mock.restore();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
