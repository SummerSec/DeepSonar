export type ReportConvergenceTransaction = (...args: any[]) => Promise<any[]>;

export interface ReportConvergenceLegacyPort {
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
