# agent-harness — 沙箱镜像与工具约定（Phase 2 建设）

ARCHITECTURE §8：harness 已收缩为「镜像定义 + hooks/MCP 白名单工具约定」，事件经 agentbox-sdk 控制通道回传（沙箱可断网、零凭据）。

## 镜像（agentbox-sdk 自定义镜像格式）

```js
// image.mjs
export default {
  name: "deepsonar-agent",
  base: "node:20-bookworm",
  run: [
    "apt-get update && apt-get install -y git python3 ca-certificates ripgrep",
    // 三家 CLI 全预装，AGENT_PROVIDER 运行时切换（claude-code | opencode | codex）
    "npm install -g @anthropic-ai/claude-code opencode-ai @openai/codex",
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
```

构建：`npx agentbox image build --provider local-docker --file ./image.mjs`

## 白名单工具注入（§3.4）

每个 Job 经 agentbox-sdk 动态注入本地 `deepsonar-control` MCP；工具按角色裁剪：

- `emit_progress` → 调度器 `progress` 事件
- `emit_fact` → 调度器 `fact` 事件（运行中可多次调用）
- `emit_finding`（payload = SARIF 子集，见 shared-types FindingPayload）→ `finding` 事件
- `submit_hub_decision` → 调度器 `hub_decision` 事件
- `mark_job_done` → `done` 事件
- `request_human` → `human` 事件

MCP 只写本地控制队列，调度器通过 agentbox 控制通道增量读取，不需要 Scheduler API/数据库凭据，也不受 Worker 目标出网策略影响。沙箱内权限完全开放（`approvalMode: "auto"`），安全边界 = 网络策略 + 一次性容器。

同一画布产生新 Fact/Finding 时，数据库 `NOTIFY` 唤醒调度器；调度器使用 `Agent.attach(...).sendMessage(...)` 给仍在运行的其他 Agent CLI 追加一条增量通知。首次 prompt 仍是完整任务，追加消息只携带提交后的新画布数据。

本地 MCP 协议冒烟：`pnpm --filter @deepsonar/scheduler exec tsx ../../agent-harness/test-control-mcp.ts`。
画布增量消息冒烟（需本地 PostgreSQL）：`pnpm --filter @deepsonar/scheduler exec tsx ../../agent-harness/test-canvas-updates.ts`。
