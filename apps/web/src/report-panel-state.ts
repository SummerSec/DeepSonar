import type { TaskReportAvailability } from "./api";

/**
 * ReportPanel 使用的异步上下文护栏。
 *
 * 切换画布或替换报告会创建新的不可变上下文；旧请求的迟到结果必须忽略。
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
    missing: null as TaskReportAvailability | null,
    loading: true,
    markdown: null,
    error: null,
    retrying: false,
    downloading: null,
    downloadError: null,
  } as const;
}

export function taskReportAvailabilityLabel(reason: TaskReportAvailability["reason"]): string {
  switch (reason) {
    case "canvas_not_found": return "任务画布不存在";
    case "root_not_found": return "任务根节点尚未创建";
    case "root_not_ready": return "分析尚未进入报告阶段";
    case "active_work": return "仍有工作正在执行";
    case "no_role_work": return "尚未产出普通角色结果";
    case "findings_not_converged": return "配置阈值范围内仍有 Finding 未收敛";
    case "report_not_dispatched": return "完成门已通过，报告任务尚未入队";
  }
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
   * React StrictMode 可能在不卸载组件时重放 layout effect（先清理再设置）；
   * 只为下一次设置重新激活护栏。
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
