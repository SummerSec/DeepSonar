import { HumanPayload } from "@deepsonar/shared-types";
import { projectJobEventPayload } from "../../credentials.js";
import { collectSecretValues, MASKED_SECRET_PLACEHOLDER, redactSecretProjection } from "../../credential-secret-projection.js";
import type { sql } from "../../db.js";

type HumanRequestPayload = Partial<Pick<HumanPayload, "reason" | "subject" | "guidance">>;
type HumanRequestAttempt = { id: string; status: string; cancel_requested: boolean };

export function redactJobHumanRequestText(value: unknown): unknown {
  if (typeof value === "string") {
    const secrets = collectSecretValues({ config: value }).sort((left, right) => right.length - left.length);
    return secrets.reduce((text, secret) => text.split(secret).join(MASKED_SECRET_PLACEHOLDER),
      redactSecretProjection(value) as string);
  }
  if (Array.isArray(value)) return value.map(redactJobHumanRequestText);
  if (!value || typeof value !== "object") return value;
  const projected = redactSecretProjection(value) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(projected).map(([key, entry]) => [key, redactJobHumanRequestText(entry)]));
}

export function projectJobHumanRequestPayload(value: unknown): HumanRequestPayload {
  const payload: HumanRequestPayload = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    const reason = HumanPayload.shape.reason.safeParse(source.reason);
    const subject = HumanPayload.shape.subject.safeParse(source.subject);
    const guidance = HumanPayload.shape.guidance.safeParse(source.guidance);
    if (reason.success) payload.reason = reason.data;
    if (subject.success) payload.subject = subject.data;
    if (guidance.success) payload.guidance = guidance.data;
  }
  return redactJobHumanRequestText(projectJobEventPayload(payload)) as HumanRequestPayload;
}

export function isCurrentJobHumanRequest(
  jobStatus: string,
  latestAttempt: HumanRequestAttempt | null,
  eventAttemptId: string | null,
): boolean {
  return (jobStatus === "running" || jobStatus === "waiting_human")
    && latestAttempt?.status === "active" && !latestAttempt.cancel_requested
    && eventAttemptId !== null && eventAttemptId === latestAttempt.id;
}

export async function readJobHumanRequest(db: typeof sql, jobId: string) {
  const [row] = await db`SELECT human.event_id,human.attempt_id,human.created_at,human.payload_json,
      j.status AS job_status,latest.id AS latest_attempt_id,latest.status AS attempt_status,latest.cancel_requested,
      EXISTS(SELECT 1 FROM human_requests r WHERE r.id=human.event_id AND r.job_id=j.id) AS managed_exists,
      EXISTS(SELECT 1 FROM human_requests r WHERE r.id=human.event_id AND r.job_id=j.id
        AND r.attempt_id=latest.id AND latest.status IN ('active','interrupted') AND NOT latest.cancel_requested
        AND r.status IN ('open','answered') AND r.resumed_at IS NULL
        AND j.status='waiting_human') AS managed_wait
    FROM jobs j
    JOIN LATERAL (SELECT event_id,attempt_id,created_at,payload_json FROM events
      WHERE job_id=j.id AND type='human' ORDER BY job_seq DESC LIMIT 1) human ON true
    LEFT JOIN LATERAL (SELECT id,status,cancel_requested FROM job_attempts
      WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE j.id=${jobId}`;
  if (!row) return null;
  const attemptId = row.attempt_id ? String(row.attempt_id) : null;
  return {
    event_id: String(row.event_id),
    attempt_id: attemptId,
    created_at: new Date(row.created_at).toISOString(),
    current: row.managed_wait===true || (!row.managed_exists && isCurrentJobHumanRequest(String(row.job_status), row.latest_attempt_id ? {
      id: String(row.latest_attempt_id), status: String(row.attempt_status), cancel_requested: row.cancel_requested === true,
    } : null, attemptId)),
    payload: projectJobHumanRequestPayload(row.payload_json),
  };
}
