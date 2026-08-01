-- 0002_canvases.sql — 画布从「每项目一个」改为「每任务一个」（一任务一画布，带目标）

-- 1. 先清掉历史重复 root（0001 的 ON CONFLICT DO NOTHING 无唯一约束，重复 sync 会插多个 root）
DELETE FROM canvas_edges e
USING canvas_nodes n
WHERE n.node_type = 'root'
  AND (e.from_node_id = n.id OR e.to_node_id = n.id)
  AND n.created_at > (SELECT MIN(m.created_at) FROM canvas_nodes m
                      WHERE m.canvas_id = n.canvas_id AND m.node_type = 'root');
DELETE FROM canvas_nodes n
WHERE n.node_type = 'root'
  AND n.created_at > (SELECT MIN(m.created_at) FROM canvas_nodes m
                      WHERE m.canvas_id = n.canvas_id AND m.node_type = 'root');

-- 2. root 幂等约束（修复 0001 的重复插入 bug）
CREATE UNIQUE INDEX canvas_nodes_root_uniq
  ON canvas_nodes (canvas_id) WHERE node_type = 'root';

-- 3. 任务画布表：一任务一画布；plane_issue_id 唯一 → 同一 issue 重试复用同一画布
CREATE TABLE canvases (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id uuid NOT NULL REFERENCES projects(id),
  plane_issue_id text,
  title text NOT NULL,
  target_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX canvases_issue_uniq
  ON canvases (plane_issue_id) WHERE plane_issue_id IS NOT NULL;
CREATE INDEX canvases_project_idx ON canvases (project_id, created_at DESC);

-- 4. jobs 挂到任务画布（nullable；历史数据走回填）
ALTER TABLE jobs ADD COLUMN canvas_id text REFERENCES canvases(id);
CREATE INDEX jobs_canvas_idx ON jobs (canvas_id);

-- 5. 回填：每个现存项目的历史画布登记为一个 canvases 行（沿用旧 canvas_id，节点/边不用动）
INSERT INTO canvases (id, project_id, title, target_json)
SELECT p.canvas_id, p.id, p.name || '（历史画布）', '{}'::jsonb
FROM projects p;

UPDATE jobs j SET canvas_id = p.canvas_id
FROM projects p
WHERE j.project_id = p.id AND j.canvas_id IS NULL;
