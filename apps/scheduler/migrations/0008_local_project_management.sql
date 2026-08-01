-- 0008: 本地项目与任务管理（docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md 阶段 A）
-- Plane 从必选入口降级为可选集成：projects.plane_project_id 可空（NULL = 纯本地项目）
-- 项目增加描述/状态/归档；删除走归档，不级联硬删除任务与 Finding

ALTER TABLE projects ALTER COLUMN plane_project_id DROP NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 既有唯一约束 projects_plane_project_id_key 天然允许多个 NULL（Postgres 语义），本地项目无需伪造 Plane ID
