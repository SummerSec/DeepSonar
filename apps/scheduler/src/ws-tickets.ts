import { randomBytes } from "node:crypto";
import type { Actor } from "./auth.js";

/** A browser WS ticket is intentionally short lived and single use. */
export const WS_TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 2048;

export interface WsTicketActor {
  type: Actor["type"];
  id: string | null;
  name: string;
  projectId: string | null;
  scopes: string[];
  role?: Actor["role"];
}

interface TicketRecord {
  jobId: string;
  expiresAt: number;
  actor: WsTicketActor;
}

const tickets = new Map<string, TicketRecord>();

function prune(now = Date.now()): void {
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(ticket);
  }
  while (tickets.size > MAX_TICKETS) {
    const first = tickets.keys().next().value as string | undefined;
    if (!first) break;
    tickets.delete(first);
  }
}

export function issueWsTicket(jobId: string, actor: Actor): { ticket: string; expires_at: string } {
  const now = Date.now();
  prune(now);
  const ticket = `dws_${randomBytes(24).toString("base64url")}`;
  tickets.set(ticket, {
    jobId,
    expiresAt: now + WS_TICKET_TTL_MS,
    actor: {
      type: actor.type,
      id: actor.id,
      name: actor.name,
      projectId: actor.projectId,
      scopes: [...actor.scopes],
      ...(actor.role ? { role: actor.role } : {}),
    },
  });
  return { ticket, expires_at: new Date(now + WS_TICKET_TTL_MS).toISOString() };
}

/** Consume means delete before returning: retrying the same browser URL fails. */
export function consumeWsTicket(ticket: string, jobId: string): WsTicketActor | null {
  prune();
  if (!ticket || ticket.length > 256) return null;
  const record = tickets.get(ticket);
  tickets.delete(ticket);
  if (!record || record.jobId !== jobId || record.expiresAt <= Date.now()) return null;
  return record.actor;
}

export function clearWsTicketsForTests(): void {
  tickets.clear();
}

