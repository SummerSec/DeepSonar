-- DeepSonar schema migration 0014
--
-- Durable per-canvas revision/change-log/tombstones for the L0 projection.
-- The runner owns the transaction; do not add BEGIN/COMMIT here.

ALTER TABLE canvases
  ADD COLUMN change_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN change_floor_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE canvases
  ADD CONSTRAINT canvases_change_revision_check CHECK (change_revision >= 0),
  ADD CONSTRAINT canvases_change_floor_check
    CHECK (change_floor_revision >= 0 AND change_floor_revision <= change_revision);

CREATE TABLE canvas_changes (
  canvas_id text NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  op text NOT NULL,
  projection_json jsonb,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, revision),
  CONSTRAINT canvas_changes_revision_check CHECK (revision > 0),
  CONSTRAINT canvas_changes_entity_type_check CHECK (entity_type IN ('node', 'edge', 'meta')),
  CONSTRAINT canvas_changes_op_check CHECK (op IN ('upsert', 'delete')),
  CONSTRAINT canvas_changes_projection_check CHECK (op = 'delete' OR projection_json IS NOT NULL)
);
CREATE INDEX canvas_changes_entity_idx ON canvas_changes (canvas_id, entity_type, entity_id, revision DESC);

CREATE OR REPLACE FUNCTION deepsonar_canvas_change_retention() RETURNS bigint AS $$
BEGIN
  RETURN 10000;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION deepsonar_canvas_append_change(
  p_canvas_id text,
  p_entity_type text,
  p_entity_id text,
  p_op text,
  p_projection jsonb
) RETURNS bigint AS $$
DECLARE
  next_revision bigint;
  pruned_revision bigint;
BEGIN
  -- The caller holds this canvas row lock.  Updating the same row serializes
  -- concurrent writers and gives a single authoritative revision sequence.
  UPDATE canvases
  SET change_revision = change_revision + 1
  WHERE id = p_canvas_id
  RETURNING change_revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'canvas % not found while appending change', p_canvas_id;
  END IF;

  INSERT INTO canvas_changes (
    canvas_id, revision, entity_type, entity_id, op, projection_json
  ) VALUES (
    p_canvas_id, next_revision, p_entity_type, p_entity_id, p_op, p_projection
  );

  -- Retain the newest bounded window.  The DELETE and floor update occur in
  -- this same transaction, so a reader never observes a half-pruned range.
  WITH removed AS (
    DELETE FROM canvas_changes
    WHERE canvas_id = p_canvas_id
      AND revision <= next_revision - deepsonar_canvas_change_retention()
    RETURNING revision
  )
  SELECT max(revision) INTO pruned_revision FROM removed;
  IF pruned_revision IS NOT NULL THEN
    UPDATE canvases
    SET change_floor_revision = GREATEST(change_floor_revision, pruned_revision)
    WHERE id = p_canvas_id;
  END IF;
  RETURN next_revision;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION deepsonar_canvas_node_l0_projection(p_node jsonb) RETURNS jsonb AS $$
DECLARE
  body jsonb := COALESCE(p_node->'body_json', '{}'::jsonb);
  progress jsonb;
BEGIN
  IF jsonb_typeof(body->'last_progress') = 'object' THEN
    progress := jsonb_build_object(
      'message', left(COALESCE(body->'last_progress'->>'message', ''), 240),
      'kind', left(COALESCE(body->'last_progress'->>'kind', ''), 64)
    );
  ELSE
    progress := NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', p_node->'id',
    'node_type', p_node->'node_type',
    'title', left(COALESCE(p_node->>'title', ''), 500),
    'body_json', jsonb_build_object(
      'summary', left(COALESCE(body->>'summary', body->>'description', body->>'message', ''), 240),
      'description', left(COALESCE(body->>'description', body->>'summary', ''), 240),
      'severity', body->>'severity',
      'role', body->>'role',
      'type', body->>'type',
      'last_progress', progress
    ),
    'x', COALESCE((p_node->>'x')::real, 0),
    'y', COALESCE((p_node->>'y')::real, 0),
    'w', COALESCE((p_node->>'w')::real, 240),
    'h', COALESCE((p_node->>'h')::real, 120),
    'status', p_node->'status',
    'verification_status', body->>'verification_status',
    'job_id', p_node->'job_id',
    'updated_at', p_node->'updated_at'
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION deepsonar_canvas_edge_l0_projection(p_edge jsonb) RETURNS jsonb AS $$
BEGIN
  RETURN jsonb_build_object(
    'id', p_edge->'id',
    'from_node_id', p_edge->'from_node_id',
    'to_node_id', p_edge->'to_node_id',
    'edge_type', p_edge->'edge_type'
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION deepsonar_canvas_meta_l0_projection(p_canvas canvases) RETURNS jsonb AS $$
BEGIN
  RETURN jsonb_build_object(
    'id', p_canvas.id,
    'title', left(p_canvas.title, 500),
    'project_id', p_canvas.project_id,
    'plane_issue_id', p_canvas.plane_issue_id,
    'status', p_canvas.status,
    'archived_at', p_canvas.archived_at
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION deepsonar_canvas_record_change() RETURNS trigger AS $$
DECLARE
  old_canvas_id text;
  new_canvas_id text;
  old_entity_id text;
  new_entity_id text;
  entity_type text;
  old_projection jsonb;
  new_projection jsonb;
BEGIN
  entity_type := CASE WHEN TG_TABLE_NAME = 'canvas_nodes' THEN 'node' ELSE 'edge' END;
  old_canvas_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.canvas_id ELSE NULL END;
  new_canvas_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.canvas_id ELSE NULL END;
  old_entity_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.id::text ELSE NULL END;
  new_entity_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.id::text ELSE NULL END;
  old_projection := CASE
    WHEN TG_OP IN ('UPDATE', 'DELETE') AND TG_TABLE_NAME = 'canvas_nodes' THEN deepsonar_canvas_node_l0_projection(to_jsonb(OLD))
    WHEN TG_OP IN ('UPDATE', 'DELETE') THEN deepsonar_canvas_edge_l0_projection(to_jsonb(OLD))
    ELSE NULL
  END;
  new_projection := CASE
    WHEN TG_OP IN ('INSERT', 'UPDATE') AND TG_TABLE_NAME = 'canvas_nodes' THEN deepsonar_canvas_node_l0_projection(to_jsonb(NEW))
    WHEN TG_OP IN ('INSERT', 'UPDATE') THEN deepsonar_canvas_edge_l0_projection(to_jsonb(NEW))
    ELSE NULL
  END;

  IF TG_OP = 'UPDATE' AND old_canvas_id IS DISTINCT FROM new_canvas_id THEN
    -- A caller may already hold either canvas lock before this trigger runs.
    -- Lexical ordering alone cannot prevent a cycle in that case, so acquire
    -- the second lock with NOWAIT and let the caller retry on 55P03 instead of
    -- waiting for PostgreSQL's deadlock detector (40P01).
    IF old_canvas_id < new_canvas_id THEN
      PERFORM 1 FROM canvases WHERE id = old_canvas_id FOR UPDATE NOWAIT;
      PERFORM 1 FROM canvases WHERE id = new_canvas_id FOR UPDATE NOWAIT;
    ELSE
      PERFORM 1 FROM canvases WHERE id = new_canvas_id FOR UPDATE NOWAIT;
      PERFORM 1 FROM canvases WHERE id = old_canvas_id FOR UPDATE NOWAIT;
    END IF;
    PERFORM deepsonar_canvas_append_change(old_canvas_id, entity_type, old_entity_id, 'delete', old_projection);
    PERFORM deepsonar_canvas_append_change(new_canvas_id, entity_type, new_entity_id, 'upsert', new_projection);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM canvases WHERE id = old_canvas_id FOR UPDATE;
    PERFORM deepsonar_canvas_append_change(old_canvas_id, entity_type, old_entity_id, 'delete', old_projection);
    RETURN OLD;
  END IF;

  PERFORM 1 FROM canvases WHERE id = new_canvas_id FOR UPDATE;
  PERFORM deepsonar_canvas_append_change(new_canvas_id, entity_type, new_entity_id, 'upsert', new_projection);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION deepsonar_canvas_record_meta_change() RETURNS trigger AS $$
BEGIN
  -- The append helper updates only change_revision/change_floor_revision, so
  -- this UPDATE OF trigger cannot recurse on its own bookkeeping columns.
  PERFORM 1 FROM canvases WHERE id = NEW.id FOR UPDATE;
  PERFORM deepsonar_canvas_append_change(NEW.id, 'meta', NEW.id, 'upsert', deepsonar_canvas_meta_l0_projection(NEW));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER canvas_nodes_revision_change
  AFTER INSERT OR UPDATE OR DELETE ON canvas_nodes
  FOR EACH ROW EXECUTE FUNCTION deepsonar_canvas_record_change();

CREATE TRIGGER canvas_edges_revision_change
  AFTER INSERT OR UPDATE OR DELETE ON canvas_edges
  FOR EACH ROW EXECUTE FUNCTION deepsonar_canvas_record_change();

CREATE TRIGGER canvases_revision_meta_change
  AFTER UPDATE OF project_id, plane_issue_id, title, target_json, trigger_source,
    trigger_event_id, trigger_payload_json, status, archived_at ON canvases
  FOR EACH ROW EXECUTE FUNCTION deepsonar_canvas_record_meta_change();

-- Seed an event-time projection for rows that predate v14.  These no-op
-- updates run inside the migration transaction after the triggers are in
-- place, preserving the existing values while making the first delta cursor
-- usable immediately after upgrade.
UPDATE canvas_nodes SET updated_at = updated_at;
UPDATE canvas_edges SET canvas_id = canvas_id;
UPDATE canvases SET title = title;
