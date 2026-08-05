import type { ReportConvergenceLegacyPort, ReportConvergenceTransaction } from "./ports.js";

export type { ReportConvergenceLegacyPort, ReportConvergenceTransaction } from "./ports.js";

export interface ReportConvergenceApplication {
  buildReportInput(canvasId: string, db?: ReportConvergenceTransaction): Promise<unknown>;
  buildFindingReportInput(findingId: string, version: number, db?: ReportConvergenceTransaction): Promise<unknown>;
  buildSarifFromConfirmed(input: unknown): object;
  maybeDispatchFindingReport(tx: ReportConvergenceTransaction, findingId: string): Promise<unknown>;
  maybeDispatchReport(tx: ReportConvergenceTransaction, canvasId: string): Promise<unknown>;
  finalizeReportJob(tx: ReportConvergenceTransaction, jobId: string, options: Record<string, unknown>): Promise<unknown>;
  readReportBlob(uri: string): Promise<Buffer>;
  getTaskReport(canvasId: string): Promise<unknown>;
  getTaskReportById(id: string): Promise<unknown>;
  getFindingReport(findingId: string): Promise<unknown>;
  getFindingReportById(id: string): Promise<unknown>;
  createFindingReport(findingId: string, force?: boolean): Promise<unknown>;
  retryReport(canvasId: string): Promise<unknown>;
}

/** Report is a read-only derivative; this seam keeps it out of lifecycle code. */
export function createReportConvergenceApplication(ports: ReportConvergenceLegacyPort): ReportConvergenceApplication {
  return {
    buildReportInput: ports.buildReportInput,
    buildFindingReportInput: ports.buildFindingReportInput,
    buildSarifFromConfirmed: ports.buildSarifFromConfirmed,
    maybeDispatchFindingReport: ports.maybeDispatchFindingReport,
    maybeDispatchReport: ports.maybeDispatchReport,
    finalizeReportJob: ports.finalizeReportJob,
    readReportBlob: ports.readReportBlob,
    getTaskReport: ports.getTaskReport,
    getTaskReportById: ports.getTaskReportById,
    getFindingReport: ports.getFindingReport,
    getFindingReportById: ports.getFindingReportById,
    createFindingReport: ports.createFindingReport,
    retryReport: ports.retryReport,
  };
}
