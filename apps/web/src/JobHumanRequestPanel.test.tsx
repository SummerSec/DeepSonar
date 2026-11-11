import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { JobDetail, JobExecutionState, JobHumanRequest } from "./api";
import { JobHumanRequestPanel, JobHumanRequestSection } from "./JobHumanRequestPanel";

const guidance = {
  question: "是否允许按已核对的范围继续验证？",
  required_action: "请核对测试资产与本次验证范围是否一致。",
  reply_instructions: "请在任务人工消息中说明核对结果，不要粘贴凭据。",
  after_reply: "收到核对结果后，按平台允许的范围决定下一步。",
};
const reason = `${"需要人工核对的完整背景。".repeat(70)}原因正文末尾。`;

function request(overrides: Partial<JobHumanRequest> = {}): JobHumanRequest {
  return {
    event_id: "human-event-1",
    attempt_id: "attempt-1",
    created_at: "2026-11-11T00:00:00Z",
    current: true,
    payload: { reason, subject: { type: "platform_blocker", kind: "authorization" }, guidance },
    ...overrides,
  };
}

function render(status: string, humanRequest: JobHumanRequest | null = request()) {
  return renderToStaticMarkup(<JobHumanRequestPanel request={humanRequest} status={status} onSendMessage={() => {}} />);
}

test("current request renders the original question, all guidance and the complete persisted reason", () => {
  const html = render("waiting_human");
  for (const value of [...Object.values(guidance), reason]) assert.ok(html.includes(value));
  assert.match(html, /当前人工请求/);
  assert.match(html, /授权确认/);
  assert.match(html, /打开任务人工消息/);
  assert.doesNotMatch(html, /最多 500 字|正在读取|读取失败|缺少可核对|event_id|attempt_id|platform_blocker/);
});

test("running with a current accepted human request is the live acceptance window, not history", () => {
  const html = render("running");
  assert.match(html, /当前人工请求/);
  assert.ok(html.includes(guidance.question));
  assert.match(html, /打开任务人工消息/);
  assert.doesNotMatch(html, /历史人工请求|运行已结束/);
});

function detail(status: string, human_request: JobHumanRequest | null, execution_state?: JobExecutionState): Pick<JobDetail, "job" | "human_request"> {
  return {
    human_request,
    job: { id: "job-1", type: "test", status, error: null, started_at: null, finished_at: null,
      payload_json: {}, agent_snapshot_json: {}, execution_state },
  };
}

test("ordinary jobs with no human request add no empty-state section", () => {
  for (const status of ["pending", "running", "succeeded", "failed"]) {
    const html = renderToStaticMarkup(<JobHumanRequestSection detail={detail(status, null)} />);
    assert.equal(html, "");
  }
});

test("waiting jobs and jobs with an accepted human receipt retain the explicit null-request state", () => {
  const waiting = renderToStaticMarkup(<JobHumanRequestSection detail={detail("waiting_human", null)} />);
  assert.match(waiting, /无持久人工请求/);
  const closed = renderToStaticMarkup(<JobHumanRequestSection detail={detail("failed", null, {
    authority: "scheduler", status: "failed", allowed_actions: ["inspect_state", "read_receipt"],
    blocker: "human_request_closed", accepted_terminal: "human", accepted_history_ref: "event-1",
  })} />);
  assert.match(closed, /无持久人工请求/);
  assert.doesNotMatch(closed, /<button|缺失|读取失败/);
});

test("a persisted historical request remains visible without a waiting status or a current human receipt", () => {
  const html = renderToStaticMarkup(<JobHumanRequestSection detail={detail("succeeded", request({ current: false }))} />);
  assert.match(html, /历史人工请求/);
  assert.ok(html.includes(reason));
  assert.doesNotMatch(html, /<button|<a\s/);
});

test("terminal requests stay readable and offer no reply, ignore or recovery action even with current=true", () => {
  for (const status of ["succeeded", "failed", "timeout", "cancelled", "orphan"]) {
    const html = render(status);
    assert.match(html, /历史人工请求/);
    assert.match(html, /运行已结束/);
    assert.match(html, /仅供查看/);
    for (const value of [...Object.values(guidance), reason]) assert.ok(html.includes(value));
    assert.doesNotMatch(html, /<button|<a\s|当前人工请求|等待你回复|去回复|恢复运行|忽略请求/);
  }
});

test("a successful detail response with null request shows an empty state without implying a read failure", () => {
  const html = render("waiting_human", null);
  assert.match(html, /无持久人工请求/);
  assert.doesNotMatch(html, /缺失|读取失败|未提供完整操作指引|<button|<a\s/);
});

test("a persisted request without guidance keeps its reason and explains only the missing instructions", () => {
  const html = render("waiting_human", request({ payload: { reason } }));
  assert.ok(html.includes(reason));
  assert.match(html, /此请求未提供完整操作指引/);
  assert.doesNotMatch(html, /正在读取|读取失败|尚未读取到|无持久人工请求/);
});

test("the same Job waiting on a new Attempt cannot turn its previous Attempt request into a current reply", () => {
  const html = render("waiting_human", request({ current: false, attempt_id: "previous-attempt" }));
  assert.match(html, /历史人工请求/);
  assert.match(html, /当前运行不再等待此请求的回复/);
  assert.ok(html.includes(guidance.question));
  assert.ok(html.includes(reason));
  assert.doesNotMatch(html, /<button|<a\s|当前人工请求/);
});

test("a current request without a task message callback only points to the existing task entry", () => {
  const html = renderToStaticMarkup(<JobHumanRequestPanel request={request()} status="waiting_human" />);
  assert.match(html, /任务中的人工消息入口/);
  assert.doesNotMatch(html, /<button|<a\s|自动恢复|晚回复续做/);
});

test("the current request opens the existing message entry and loses that action when it becomes historical", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let opened = 0;
  try {
    await act(async () => root.render(<JobHumanRequestPanel request={request()} status="waiting_human" onSendMessage={() => { opened += 1; }} />));
    const button = dom.window.document.querySelector("button");
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(opened, 1);
    await act(async () => root.render(<JobHumanRequestPanel request={request({ current: false })} status="waiting_human" onSendMessage={() => { opened += 1; }} />));
    assert.equal(dom.window.document.querySelector("button"), null);
    assert.ok(dom.window.document.body.textContent?.includes(guidance.question));
    assert.equal(opened, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
