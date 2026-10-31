import { z } from "zod";
import {
  CUSTOM_EXPORT_MODULES,
  rejectUnknownProjectExportModules,
} from "./modules.js";

export const ProjectExportBody = z.object({
  preset: z.enum(["configuration", "project_full", "evidence_archive", "custom"]).default("configuration"),
  modules: z.array(z.enum(CUSTOM_EXPORT_MODULES)).optional(),
  include_blobs: z.boolean().optional(),
  allow_active_jobs: z.boolean().optional(),
  credentials: z.object({ mode: z.enum(["excluded", "metadata"]).optional() }).optional(),
});

export type ProjectExportBody = z.infer<typeof ProjectExportBody>;

export function parseProjectExportRequest(
  input: unknown,
):
  | { ok: true; body: ProjectExportBody }
  | { ok: false; status: 400; body: NonNullable<ReturnType<typeof rejectUnknownProjectExportModules>> } {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rejected = rejectUnknownProjectExportModules(raw.preset, raw.modules);
  if (rejected) return { ok: false, status: 400, body: rejected };
  return { ok: true, body: ProjectExportBody.parse(raw) };
}
