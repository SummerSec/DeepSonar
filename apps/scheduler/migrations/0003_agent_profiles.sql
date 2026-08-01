-- 0003_agent_profiles.sql — Agent 配置体系（§8.1）：profile 存储 + job 级快照

-- Agent profile：一套可复用的 agent 运行配置（CLI/模型/env 引用/skill 下发/提示词后缀）
-- 纪律（§9）：env_keys 只存变量名引用，密钥值永远不落库，运行时从调度器 process.env 解析
CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  agent_cli text NOT NULL DEFAULT 'claude-code',   -- claude-code | open-code | codex
  model text,
  env_keys text[] NOT NULL DEFAULT '{}',
  skills_json jsonb NOT NULL DEFAULT '[]',          -- agentbox skills（repo 或 embedded）
  commands_json jsonb NOT NULL DEFAULT '[]',        -- 自定义 slash 命令
  mcps_json jsonb NOT NULL DEFAULT '[]',            -- MCP server（local/remote）
  subagents_json jsonb NOT NULL DEFAULT '[]',       -- 子 agent
  prompt_suffix text,                               -- 追加到任务 prompt 的 profile 级指令
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- job 创建时冻结的 profile 快照：下一 job 生效 + 历史 job 可复现（改 profile 不影响已建 job）
ALTER TABLE jobs ADD COLUMN agent_snapshot_json jsonb;
