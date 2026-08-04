import assert from "node:assert/strict";
import test from "node:test";
import { clearWsTicketsForTests, consumeWsTicket, issueWsTicket } from "./ws-tickets.js";

test("browser WS tickets are scoped and single use", () => {
  clearWsTicketsForTests();
  const actor = {
    type: "user" as const,
    id: "user-1",
    name: "operator",
    projectId: "project-1",
    scopes: ["tasks:read"],
    role: "operator" as const,
  };
  const issued = issueWsTicket("job-1", actor);
  assert.ok(issued.ticket.startsWith("dws_"));
  assert.equal(consumeWsTicket(issued.ticket, "job-2"), null);
  // A failed scope/job match also consumes the opaque value.
  assert.equal(consumeWsTicket(issued.ticket, "job-1"), null);

  const second = issueWsTicket("job-1", actor);
  const consumed = consumeWsTicket(second.ticket, "job-1");
  assert.equal(consumed?.id, "user-1");
  assert.equal(consumeWsTicket(second.ticket, "job-1"), null);
  clearWsTicketsForTests();
});

