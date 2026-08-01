// DeepFlowHunter 沙箱镜像（agentbox-sdk 自定义镜像格式）
// 本地构建：npx agentbox image build --provider local-docker --file ./agent-harness/image.mjs
// 注意：npm 上裸名 agentbox 是 0.0.1-security 占位包！真实 CLI 是 @madarco/agentbox：
//   npx -y @madarco/agentbox image build --provider local-docker --file ./agent-harness/image.mjs
// 生产/CI 构建走 deploy/Dockerfile.agent（基础镜像 digest + npm 版本固定，§12.1），版本号两边同步。
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
    // 版本固定（§12.1：不装 latest；升级走显式改这里 + deploy/Dockerfile.agent）
    "npm install -g @anthropic-ai/claude-code@2.1.220 @anthropic-ai/claude-agent-sdk@0.3.220",
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
