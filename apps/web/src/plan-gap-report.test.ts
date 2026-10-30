import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "./MarkdownView.js";
import { withPlanGapReport } from "../../scheduler/src/domains/plan-protocol/gap-projection.js";

for (const tail of ["<!--", "```", "````json", "~~~html", "<script>", "<div hidden>"]) {
  test(`gap section is visibly rendered before an unclosed model tail ${JSON.stringify(tail)}`, () => {
    const modelText = `## 已确认问题\n\nfinding-id\n\n${tail}`;
    const markdown = withPlanGapReport(modelText, {
      v: 1, scope: "canvas_plan_audits", entries: [], truncated: false, limit: 32,
    });
    const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
    const outsideCode = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, "");
    assert.match(outsideCode, /目标与缺口（只读计划审计）/);
    assert.match(outsideCode, /unknown/);
    assert.ok(markdown.indexOf("## 目标与缺口") < markdown.indexOf(tail));
    assert.doesNotMatch(html, /<(?:script|iframe|img)\b|<div hidden>/);
  });
}

test("projection text remains escaped inside its own rendered JSON fence", () => {
  const markdown = withPlanGapReport("Report body", {
    v: 1, scope: "canvas_plan_audits", truncated: false, limit: 32,
    entries: [{ job_id: '<img src=x onerror="alert(1)">\n```\n<!--', availability: "invalid", audit: null }],
  });
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
  assert.doesNotMatch(html, /<img\b|<!--/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Report body/);
});
