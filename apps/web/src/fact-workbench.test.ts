import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { api } from "./api";
import { appendUniqueRows, initializePageProgress, mergeRefreshedPage } from "./canvas-page-sync";
import { factPageFilterKey, readFactPageFilters, updateFactPageQuery } from "./fact-page-state";

const sourceRoot = path.resolve(import.meta.dirname);
const source = (name: string) => readFileSync(path.join(sourceRoot, name), "utf8");

test("Fact URL 深链与四类服务端筛选可独立更新并保留工作台状态", () => {
  const findingId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  const initial = new URLSearchParams(`tab=facts&verification_status=verified,rejected&evidence_kind=review,test&finding_id=${findingId}&job_id=${jobId}`);
  assert.deepEqual(readFactPageFilters(initial), {
    verification_status: ["verified", "rejected"],
    evidence_kind: ["review", "test"],
    finding_id: [findingId],
    job_id: [jobId],
  });

  const opened = updateFactPageQuery(initial, "fact", "fact-1");
  assert.equal(opened.get("tab"), "facts");
  assert.equal(opened.get("fact"), "fact-1");
  assert.equal(opened.get("verification_status"), "verified,rejected");

  const cleared = updateFactPageQuery(opened, "evidence_kind", []);
  assert.equal(cleared.has("evidence_kind"), false);
  assert.equal(cleared.get("fact"), "fact-1");

  const partialUuid = readFactPageFilters(new URLSearchParams("tab=facts&finding_id=11111111-1111"));
  assert.deepEqual(partialUuid.finding_id, [], "半截 UUID 不得进入服务端筛选请求");
});

test("Fact 筛选 key 只随内容变化，不随新数组引用变化", () => {
  const params = new URLSearchParams("tab=facts&verification_status=verified,rejected&evidence_kind=review");
  const first = readFactPageFilters(params);
  const second = readFactPageFilters(new URLSearchParams(params));
  assert.notEqual(first.verification_status, second.verification_status, "解析结果每次都是新数组实例");
  assert.equal(factPageFilterKey(first), factPageFilterKey(second));

  const changed = readFactPageFilters(new URLSearchParams("tab=facts&verification_status=rejected"));
  assert.notEqual(factPageFilterKey(first), factPageFilterKey(changed));

  const tabOnly = readFactPageFilters(new URLSearchParams("tab=canvas"));
  const factOpen = readFactPageFilters(new URLSearchParams("tab=facts&fact=node-1"));
  assert.equal(factPageFilterKey(tabOnly), factPageFilterKey(factOpen), "tab/fact 深链不得扰动轮询 key");
});

test("Fact 轮询 interval 依赖稳定筛选 key，不把每渲染新建的数组放进 useEffect", () => {
  const page = source("pages/TaskCanvasPage.tsx");
  assert.match(page, /const factFilterKey = factPageFilterKey\(readFactPageFilters\(searchParams\)\)/);
  assert.match(page, /const factFilters = useMemo\(/);
  assert.match(page, /\[canvasId, factFilterKey, factsRefresh\]/);
  const effectStart = page.indexOf("const tick = async () => {");
  const effectEnd = page.indexOf("[canvasId, factFilterKey, factsRefresh]");
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "找不到 facts 轮询 effect");
  const effect = page.slice(effectStart, effectEnd);
  assert.match(effect, /window\.setInterval\(\(\) => void tick\(\), 5000\)/);
  assert.doesNotMatch(effect, /factFilters\.evidence_kind,/);
  assert.doesNotMatch(effect, /factFilters\.finding_id,/);
  assert.doesNotMatch(effect, /factFilters\.job_id,/);
  assert.doesNotMatch(effect, /factFilters\.verification_status,/);
});

test("Fact 与 Finding 人工动作发送画布作用域路径和严格请求体", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await api.setFactVerification("canvas-1", "fact-1", "verified", "人工确认");
    await api.setFactVerification("canvas-1", "fact-1", "rejected");
    await api.setFactVerification("canvas-1", "fact-1", "needs_human", "需要判断");
    await api.forceFindingVerify("finding-1", { reason: "人工复核" });
    await api.createFindingEvidenceJob("finding-1", "review");
    await api.createFindingEvidenceJob("finding-1", "test");
  } finally {
    globalThis.fetch = originalFetch;
    if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }

  assert.deepEqual(calls, [
    { url: "/api/canvases/canvas-1/facts/fact-1/verification", method: "PATCH", body: { status: "verified", note: "人工确认" } },
    { url: "/api/canvases/canvas-1/facts/fact-1/verification", method: "PATCH", body: { status: "rejected" } },
    { url: "/api/canvases/canvas-1/facts/fact-1/verification", method: "PATCH", body: { status: "needs_human", note: "需要判断" } },
    { url: "/api/findings/finding-1/verify", method: "POST", body: { reason: "人工复核" } },
    { url: "/api/findings/finding-1/evidence-jobs", method: "POST", body: { role: "review" } },
    { url: "/api/findings/finding-1/evidence-jobs", method: "POST", body: { role: "test" } },
  ]);
});

test("Fact 首屏轮询不会回退已加载页，加载更多按 id 去重", () => {
  const progress = initializePageProgress(null, { next_cursor: "cursor-1", has_more: true });
  assert.deepEqual(
    initializePageProgress(progress, { next_cursor: "new-first-page-cursor", has_more: false }),
    progress,
  );

  const loaded = [{ id: "3" }, { id: "2" }, { id: "1" }];
  assert.deepEqual(mergeRefreshedPage([{ id: "4" }, { id: "3" }], loaded).map((row) => row.id), ["4", "3", "2", "1"]);
  assert.deepEqual(appendUniqueRows(loaded, [{ id: "1" }, { id: "0" }]).map((row) => row.id), ["3", "2", "1", "0"]);
});

test("Fact API 与列表使用画布作用域、严格筛选和 keyset 游标", () => {
  const api = source("api.ts");
  const page = source("pages/TaskCanvasPage.tsx");
  assert.match(api, /\/canvases\/\$\{canvasId\}\/facts\$\{qs/);
  assert.match(api, /verification_status: opts\?\.verification_status/);
  assert.match(api, /evidence_kind: opts\?\.evidence_kind/);
  assert.match(api, /finding_id: opts\?\.finding_id/);
  assert.match(api, /job_id: opts\?\.job_id/);
  assert.match(api, /\/facts\/\$\{nodeId\}\/verification/);
  assert.match(page, /mergeRefreshedPage\(page\.items, before\)/);
  assert.match(page, /appendUniqueRows\(before, next\.items\)/);
  assert.match(page, /after: factsCursor/);
  assert.match(page, /factFindingFilterOptions/);
  assert.match(page, /factJobFilterOptions/);
});

test("Canvas Fact 点击交给深链面板，不再同时打开通用 Sidebar", () => {
  const canvas = source("CanvasView.tsx");
  assert.match(canvas, /found\?\.node_type === "fact" && onOpenFact/);
  assert.match(canvas, /clearSelected\(\);\s*onOpenFact\(found\.id\);\s*return;/s);
  assert.match(canvas, /onOpenFact\?: \(factId: string\) => void/);
});

test("Fact 详情覆盖三段内容、关闭状态与待人工裁决", () => {
  const panel = source("FactDetailPanel.tsx");
  assert.match(panel, /aria-label="Fact 详情"/);
  assert.match(panel, /event\.key !== "Escape"/);
  assert.match(panel, /event\.target === event\.currentTarget && onClose\(\)/);
  assert.match(panel, /Fact 不存在或已从当前画布删除/);
  assert.match(panel, />详情</);
  assert.match(panel, />结构化证据</);
  assert.match(panel, />证据链路</);
  assert.match(panel, /verification_status === "needs_human"/);
  assert.match(panel, /resolveFact\("verified"\)/);
  assert.match(panel, /resolveFact\("rejected"\)/);
  assert.match(panel, /onOpenFinding\(finding\.id\)/);
  assert.match(panel, /onOpenJob\(job\.id\)/);
});

test("Finding 待人工区提供强制验证与两类结构化证据 Job", () => {
  const api = source("api.ts");
  const panel = source("FindingDetailPanel.tsx");
  assert.match(api, /`\/findings\/\$\{id\}\/verify`/);
  assert.match(api, /`\/findings\/\$\{id\}\/evidence-jobs`/);
  assert.match(panel, /forceFindingVerify/);
  assert.match(panel, /createFindingEvidenceJob/);
  assert.match(panel, /f\.verify_status !== "confirmed" && f\.verify_status !== "needs_human"/);
  assert.match(panel, /派发独立复核/);
  assert.match(panel, /派发运行测试/);
  assert.match(panel, /\{f\.has_waiting_human && \(/);
  assert.match(panel, /技术 confirmed 只能由 Scheduler Verify/);
});

test("人工介入只读取 human 节点结构化关联且有界展示", () => {
  const page = source("pages/TaskCanvasPage.tsx");
  assert.match(page, /node\.node_type === "human"/);
  assert.match(page, /\.slice\(0, 12\)/);
  assert.match(page, /body_json\?\.subject/);
  assert.match(page, /body_json\?\.finding_id/);
  assert.match(page, /body_json\?\.job_id/);
  assert.doesNotMatch(page, /match\([^\n]*finding_id|description[^\n]*finding_id/);
});
