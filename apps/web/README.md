# @dfh/web — 画布前端（Phase 2 建设）

技术选型已定（ARCHITECTURE §5/§16）：**React + React Flow (@xyflow/react, MIT)**

- 数据源：`GET /projects/{id}/canvas`（nodes/edges 与 React Flow 1:1 映射）
- 只读渲染：`nodesDraggable={false}`，坐标服务端分配（§3.2）
- 自定义节点组件：root / job / finding / note / human（finding 卡片含 severity 徽章、verify 状态）
- 更新方式：MVP 轮询；WS 只推引用 `{node_id, version}` 客户端再拉（§6.4）
- 大画布：`onlyRenderVisibleElements` + 按 job 分组折叠（§6.4）
