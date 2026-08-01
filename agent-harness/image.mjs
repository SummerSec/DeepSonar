// DeepFlowHunter 沙箱镜像（agentbox-sdk 自定义镜像格式）
// 构建：npx agentbox image build --provider local-docker --file ./agent-harness/image.mjs
export default {
  name: "deepflowhunter-agent",
  base: "node:20-bookworm",
  env: {
    // Claude Code 在容器内以 root 运行时跳过部分检查
    IS_SANDBOX: "1",
  },
  run: [
    "apt-get update && apt-get install -y git python3 ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*",
    // 默认预装 claude-code；如需 opencode/codex 追加：opencode-ai @openai/codex
    // claude-agent-sdk 是 agentbox daemon 的依赖（relay 模式必需，缺了 setup() 直接抛错）
    "npm install -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk",
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
