/**
 * 任务工作台层叠契约（#185 / #219）：
 * - 切走过程画布时 CanvasView 保持挂载，用 visibility 保住 React Flow 尺寸，不用 display:none。
 * - 绝对定位画布会盖住同级 in-flow 列表；非画布 Tab 必须用更高 z-index + 不透明表面盖住合成层。
 * - 画布 Job/节点抽屉是 viewport overlay，切走时不得继续渲染。
 */

export function taskWorkbenchCanvasLayerClass(active: boolean): string {
  return active
    ? "absolute inset-0 z-0 flex min-h-0 flex-col"
    : "absolute inset-0 z-0 isolate flex min-h-0 flex-col invisible pointer-events-none";
}

export function taskWorkbenchListPaneClass(): string {
  return "theme-drawer relative z-10 min-h-0 flex-1";
}

export function shouldRenderCanvasOverlays(active: boolean): boolean {
  return active;
}
