import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  api,
  parseContentDispositionFilename,
  setLocalToken,
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
