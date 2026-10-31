import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasEdge, CanvasNode } from "./api";
import {
  capRenderedIds,
  childLimitFor,
  computeNodeDepths,
  computeVisibleIds,
  DEFAULT_CHILD_LIMIT,
  DEFAULT_VISIBLE_NODE_BUDGET,
  MAX_RENDERED_NODES,
  nextVisibleNodeBudget,
  remainingCappedChildren,
} from "./graph-depth";

function node(id: string, node_type: CanvasNode["node_type"] = "fact"): CanvasNode {
  return {
    id,
    node_type,
    title: id,
    body_json: {},
    x: 0,
    y: 0,
    w: 240,
    h: 120,
    status: "active",
    verification_status: null,
    job_id: null,
    updated_at: "",
  };
}

function edge(from: string, to: string, id = `${from}->${to}`): CanvasEdge {
  return { id, from_node_id: from, to_node_id: to, edge_type: "child" };
}

test("bushy graphs keep default child cap instead of mounting every fact", () => {
  const facts = Array.from({ length: 40 }, (_, i) => node(`f${i}`));
  const nodes = [node("root", "root"), node("hub", "job"), ...facts];
  const edges = [edge("root", "hub"), ...facts.map((fact) => edge("hub", fact.id))];
  const depths = computeNodeDepths(nodes, edges);
  const visible = computeVisibleIds(nodes, edges, depths, 3, new Set(), new Set(), () => DEFAULT_CHILD_LIMIT);
  assert.equal(visible.has("root"), true);
  assert.equal(visible.has("hub"), true);
  assert.equal([...visible].filter((id) => id.startsWith("f")).length, DEFAULT_CHILD_LIMIT);
  assert.equal(remainingCappedChildren("hub", new Map([["hub", facts.map((fact) => fact.id)]]), DEFAULT_CHILD_LIMIT), 28);
});

test("sibling projection is deterministic regardless of API edge order", () => {
  const nodes = [node("root", "root"), node("b"), node("a"), node("c")];
  const shuffled = [edge("root", "c", "edge-3"), edge("root", "a", "edge-1"), edge("root", "b", "edge-2")];
  const reversed = [...shuffled].reverse();
  const depths = computeNodeDepths(nodes, shuffled);
  const first = computeVisibleIds(nodes, shuffled, depths, 2, new Set(), new Set(), () => 2);
  const second = computeVisibleIds(nodes, reversed, depths, 2, new Set(), new Set(), () => 2);
  assert.deepEqual([...first], ["root", "b", "a"], "stable node creation order wins over edge arrival order");
  assert.deepEqual([...second], [...first]);
});

test("revealing extra children raises only that parent's cap", () => {
  assert.equal(childLimitFor("hub", new Map([["hub", 12]])), DEFAULT_CHILD_LIMIT + 12);
  assert.equal(childLimitFor("other", new Map([["hub", 12]])), DEFAULT_CHILD_LIMIT);
});

test("attribute-filter path can skip the child cap", () => {
  const facts = Array.from({ length: 20 }, (_, i) => node(`f${i}`));
  const nodes = [node("root", "root"), ...facts];
  const edges = facts.map((fact) => edge("root", fact.id));
  const depths = computeNodeDepths(nodes, edges);
  const uncapped = computeVisibleIds(nodes, edges, depths, 3, new Set(), new Set());
  assert.equal(uncapped.size, 21);
});

test("render cap keeps root and truncates the rest", () => {
  const nodes = [node("root", "root"), node("a"), node("b"), node("c")];
  const depths = new Map([["root", 1], ["a", 2], ["b", 2], ["c", 2]]);
  const capped = capRenderedIds(new Set(nodes.map((item) => item.id)), nodes, depths, 2);
  assert.equal(capped.truncated, 2);
  assert.equal(capped.ids.has("root"), true);
  assert.equal(capped.ids.size, 2);
});

test("render cap preserves stable node creation order within the same depth", () => {
  const depths = new Map([["root", 1], ["a", 2], ["b", 2], ["c", 2]]);
  const ids = new Set(["root", "a", "b", "c"]);
  const capped = capRenderedIds(ids, [node("root", "root"), node("c"), node("a"), node("b")], depths, 3);
  assert.deepEqual([...capped.ids], ["root", "c", "a"]);
});

test("default total budget bounds shallow wide graphs and reveals stable batches", () => {
  const children = Array.from({ length: 50 }, (_, index) => node(`n${index}`));
  const nodes = [node("root", "root"), ...children];
  const depths = new Map(nodes.map((item) => [item.id, item.node_type === "root" ? 1 : 2]));
  const first = capRenderedIds(new Set(nodes.map((item) => item.id)), nodes, depths, DEFAULT_VISIBLE_NODE_BUDGET);
  assert.equal(first.ids.size, DEFAULT_VISIBLE_NODE_BUDGET);
  assert.deepEqual([...first.ids].slice(0, 4), ["root", "n0", "n1", "n2"]);
  assert.equal(first.truncated, 51 - DEFAULT_VISIBLE_NODE_BUDGET);

  const secondBudget = nextVisibleNodeBudget(DEFAULT_VISIBLE_NODE_BUDGET, nodes.length);
  assert.equal(secondBudget, 48);
  const second = capRenderedIds(new Set(nodes.map((item) => item.id)), nodes, depths, secondBudget);
  assert.deepEqual([...second.ids].slice(0, DEFAULT_VISIBLE_NODE_BUDGET), [...first.ids]);
  assert.equal(nextVisibleNodeBudget(secondBudget, nodes.length), nodes.length);
  assert.equal(nextVisibleNodeBudget(MAX_RENDERED_NODES, 500), MAX_RENDERED_NODES);
});
