# agent-harness — 沙箱镜像与工具约定（Phase 2 建设）

ARCHITECTURE §8：harness 已收缩为「镜像定义 + hooks/MCP 白名单工具约定」，事件经 agentbox-sdk 控制通道回传（沙箱可断网、零凭据）。

## 镜像（agentbox-sdk 自定义镜像格式）

```js
// image.mjs
export default {
  name: "deepflowhunter-agent",
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

经 agentbox-sdk 的 claude-code provider 配置注入 hooks/MCP：

- `emit_progress` → 调度器 `progress` 事件
- `emit_finding`（payload = SARIF 子集，见 shared-types FindingPayload）→ `finding` 事件
- `mark_job_done` → `done` 事件
- `request_human` → `human` 事件

沙箱内权限完全开放（`approvalMode: "auto"`），安全边界 = 沙箱（`networkMode: "none"` 断网 + 一次性容器）。
