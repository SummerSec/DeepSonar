-- 0004_skill_sources.sql — Git 模块源（§8.2）：插件/skill 集中托管在 Git 仓库，profile 按需勾选

-- 模块源：一个 Git 仓库 = 一组可选模块（插件 / skill）
-- catalog_json 在 sync 时扫描生成并缓存模块文件内容（下发时不再访问 Git）
CREATE TABLE skill_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  repo_url text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  catalog_json jsonb NOT NULL DEFAULT '[]',   -- [{id, kind, plugin, name, path, description, files}]
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- profile 勾选的模块：["<source_id>:<module_id>", ...]
-- 快照时展开为 embedded skills/commands 合并进 skills/commands 数组（历史 job 可复现）
ALTER TABLE agent_profiles ADD COLUMN modules_json jsonb NOT NULL DEFAULT '[]';
