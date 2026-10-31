import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import {
  api,
  parseContentDispositionFilename,
  setLocalToken,
  TaskReportUnavailableError,
} from "./api";

type Anchor = {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click: () => void;
  remove: () => void;
};

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as Record<string, unknown>).document;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function installBrowserMocks() {
  const calls: { url: string; headers: HeadersInit | undefined }[] = [];
  const anchors: Anchor[] = [];
  let created = 0;
  let revoked = 0;
  let clicked = 0;
  const body = { appendChild: () => undefined };
  (globalThis as Record<string, unknown>).document = {
    body,
    createElement: () => {
      const anchor: Anchor = {
        href: "",
        download: "",
        rel: "",
        style: { display: "" },
        click: () => { clicked += 1; },
        remove: () => undefined,
      };
      anchors.push(anchor);
      return anchor;
    },
  };
  URL.createObjectURL = () => {
    created += 1;
    return `blob:test-${created}`;
  };
  URL.revokeObjectURL = () => {
    revoked += 1;
  };
  return { calls, anchors, get created() { return created; }, get revoked() { return revoked; }, get clicked() { return clicked; } };
}

function installStorage(values: Record<string, string> = {}) {
  const store = new Map(Object.entries(values));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = originalDocument;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  delete (globalThis as Record<string, unknown>).localStorage;
});

test("authenticated report download sends Bearer and uses server filename/object URL", async () => {
  const browser = installBrowserMocks();
  installStorage({ deepsonar_session: "deepsonar_user_test_token" });
  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    return new Response("# report", {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": "attachment; filename=\"task-report.md\"",
      },
    });
  };

  await api.downloadReport("report-id", "markdown");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requestUrl, "/api/reports/report-id/markdown");
  assert.deepEqual(requestHeaders, { Authorization: "Bearer deepsonar_user_test_token" });
  assert.equal(browser.anchors[0]?.download, "task-report.md");
  assert.equal(browser.anchors[0]?.href, "blob:test-1");
  assert.equal(browser.created, 1);
  assert.equal(browser.revoked, 1);
  assert.equal(browser.clicked, 1);
  assert.doesNotMatch(requestUrl, /token|Bearer/i);
});

test("missing/expired authorization errors never create a report download", async () => {
  const browser = installBrowserMocks();
  installStorage();
  let seenHeaders: HeadersInit | undefined;
  globalThis.fetch = async (_input, init) => {
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({ error: "缺少 Authorization: Bearer <token>" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    api.downloadReport("report-id", "markdown"),
    /登录已失效或未登录.*缺少 Authorization/,
  );
  assert.deepEqual(seenHeaders, {});
  assert.equal(browser.created, 0);
  assert.equal(browser.anchors.length, 0);
});

test("forbidden report download surfaces text error and does not save JSON", async () => {
  const browser = installBrowserMocks();
  installStorage({ deepsonar_api_token: "deepsonar_dev_token" });
  globalThis.fetch = async () => new Response("project token mismatch", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

  await assert.rejects(api.downloadReport("report-id", "sarif"), /当前账号无权下载该报告.*project token mismatch/);
  assert.equal(browser.created, 0);
  assert.equal(browser.anchors.length, 0);
});

test("content-disposition parser rejects path traversal and decodes RFC 5987 names", () => {
  assert.equal(parseContentDispositionFilename("attachment; filename*=UTF-8''报告%20一.md", "report.md"), "报告 一.md");
  assert.equal(parseContentDispositionFilename("attachment; filename=\"..\\evil.md\"", "report.md"), "report.md");
  assert.equal(parseContentDispositionFilename("attachment", "report.md"), "report.md");
});

test("setLocalToken keeps session and API token precedence explicit", () => {
  installStorage();
  setLocalToken("deepsonar_user_session");
  assert.equal((globalThis as { localStorage: { getItem(key: string): string | null } }).localStorage.getItem("deepsonar_session"), "deepsonar_user_session");
});

test("leftover deepsonar_token localStorage key is not migrated", () => {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /LEGACY_TOKEN_KEY|deepsonar_token|migrateLegacyTokenKeys/);
  installStorage({ deepsonar_token: "deepsonar_user_stale" });
  setLocalToken("deepsonar_user_session");
  const storage = (globalThis as { localStorage: { getItem(key: string): string | null } }).localStorage;
  assert.equal(storage.getItem("deepsonar_session"), "deepsonar_user_session");
  assert.equal(storage.getItem("deepsonar_token"), "deepsonar_user_stale");
});

test("任务报告 404 会读取服务端 availability 并保留阻塞 Finding", async () => {
  installStorage({ deepsonar_session: "deepsonar_user_test_token" });
  const availability = {
    reason: "findings_not_converged",
    root_status: "analysis_complete",
    min_verify_severity: "high",
    blockers: ["finding:finding-1:pending"],
    blocking_findings: [{
      finding_id: "finding-1",
      title: "待验证问题",
      severity: "high",
      verify_status: "pending",
      issue: "Finding 未收敛",
    }],
  } as const;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    if (String(input).endsWith("/report")) return new Response(JSON.stringify({ error: "report not found" }), { status: 404 });
    return new Response(JSON.stringify(availability), { status: 200, headers: { "content-type": "application/json" } });
  };

  await assert.rejects(
    api.canvasReport("canvas-1"),
    (error: unknown) => {
      assert.ok(error instanceof TaskReportUnavailableError);
      assert.equal(error.availability.blocking_findings[0]?.finding_id, "finding-1");
      return true;
    },
  );
  assert.deepEqual(requests, ["/api/canvases/canvas-1/report", "/api/canvases/canvas-1/report/availability"]);
});

test("任务报告 availability 请求失败时保留原始 404 错误", async () => {
  installStorage({ deepsonar_session: "deepsonar_user_test_token" });
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ error: String(input).endsWith("/report") ? "report not found" : "service unavailable" }), {
      status: String(input).endsWith("/report") ? 404 : 503,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(api.canvasReport("canvas-2"), /\/canvases\/canvas-2\/report -> 404: report not found/);
  assert.deepEqual(requests, ["/api/canvases/canvas-2/report", "/api/canvases/canvas-2/report/availability"]);
});
