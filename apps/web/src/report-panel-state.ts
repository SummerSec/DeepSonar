/**
 * Async context guards used by ReportPanel.
 *
 * A canvas switch or report replacement creates a new immutable context. Any
 * request that captured the previous context must ignore its late completion.
 */
export type ReportPanelContext = Readonly<{
  canvasId: string;
  generation: number;
  reportId: string | null;
  reportStatus: string | null;
}>;

export type ReportPanelPollToken = Readonly<{
  context: ReportPanelContext;
  sequence: number;
}>;

export function resetReportPanelState() {
  return {
    report: null,
    missing: false,
    markdown: null,
    error: null,
    retrying: false,
    downloading: null,
    downloadError: null,
  } as const;
}

export class ReportPanelAsyncGuard {
  private context: ReportPanelContext;
  private latestPollSequence = 0;
  private disposed = false;

  constructor(canvasId: string) {
    this.context = Object.freeze({
      canvasId,
      generation: 0,
      reportId: null,
      reportStatus: null,
    });
  }

  get currentContext(): ReportPanelContext {
    return this.context;
  }

  update(canvasId: string, reportId: string | null, reportStatus: string | null): ReportPanelContext {
    if (this.disposed) return this.context;
    const canvasChanged = canvasId !== this.context.canvasId;
    const generation = canvasChanged ? this.context.generation + 1 : this.context.generation;
    if (
      canvasId !== this.context.canvasId ||
      reportId !== this.context.reportId ||
      reportStatus !== this.context.reportStatus
    ) {
      this.context = Object.freeze({ canvasId, generation, reportId, reportStatus });
      if (canvasChanged) this.latestPollSequence = 0;
    }
    return this.context;
  }

  beginPoll(): ReportPanelPollToken {
    if (this.disposed) return Object.freeze({ context: this.context, sequence: 0 });
    const sequence = ++this.latestPollSequence;
    return Object.freeze({ context: this.context, sequence });
  }

  isCurrentPoll(token: ReportPanelPollToken): boolean {
    return !this.disposed && token.context === this.context && token.sequence === this.latestPollSequence;
  }

  isCurrentContext(context: ReportPanelContext): boolean {
    return !this.disposed && context === this.context;
  }

  isCurrentCanvas(context: ReportPanelContext): boolean {
    return (
      !this.disposed &&
      context.canvasId === this.context.canvasId &&
      context.generation === this.context.generation
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.latestPollSequence = 0;
    this.context = Object.freeze({
      canvasId: "",
      generation: this.context.generation + 1,
      reportId: null,
      reportStatus: null,
    });
  }

  /**
   * React StrictMode may replay layout effects (cleanup then setup) without
   * unmounting the component. Re-arm the guard only for that next setup.
   */
  reactivate(canvasId: string, reportId: string | null, reportStatus: string | null): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.latestPollSequence = 0;
    this.context = Object.freeze({
      canvasId,
      generation: this.context.generation + 1,
      reportId,
      reportStatus,
    });
  }
}
