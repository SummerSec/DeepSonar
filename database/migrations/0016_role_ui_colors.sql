-- DeepSonar schema migration 0016
--
-- Role colors are scheduler-governed metadata.  The migration backfills
-- existing worker roles in deterministic name order; hub/system roles remain
-- NULL because their semantic colors are fixed by the canvas renderer.
-- The runner owns the transaction; do not add BEGIN/COMMIT here.

ALTER TABLE agent_roles
  ADD COLUMN ui_color text;

ALTER TABLE agent_roles
  ADD CONSTRAINT agent_roles_ui_color_check
    CHECK (ui_color IS NULL OR ui_color ~ '^#[0-9A-Fa-f]{6}$');

CREATE OR REPLACE FUNCTION deepsonar_role_generated_color(p_index int) RETURNS text AS $$
DECLARE
  hue double precision := (mod((p_index::numeric * 137.507764::numeric), 360::numeric)::double precision) / 360;
  saturation double precision := 0.72;
  lightness double precision := 0.62;
  chroma double precision := (1 - abs(2 * lightness - 1)) * saturation;
  segment double precision := hue * 6;
  x double precision := chroma * (1 - abs(mod(segment::numeric, 2::numeric)::double precision - 1));
  match_value double precision := lightness - chroma / 2;
  red double precision;
  green double precision;
  blue double precision;
BEGIN
  IF segment < 1 THEN red := chroma; green := x; blue := 0;
  ELSIF segment < 2 THEN red := x; green := chroma; blue := 0;
  ELSIF segment < 3 THEN red := 0; green := chroma; blue := x;
  ELSIF segment < 4 THEN red := 0; green := x; blue := chroma;
  ELSIF segment < 5 THEN red := x; green := 0; blue := chroma;
  ELSE red := chroma; green := 0; blue := x;
  END IF;
  RETURN format('#%02s%02s%02s',
    lpad(to_hex(round((red + match_value) * 255)::int), 2, '0'),
    lpad(to_hex(round((green + match_value) * 255)::int), 2, '0'),
    lpad(to_hex(round((blue + match_value) * 255)::int), 2, '0'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $$
DECLARE
  palette text[] := ARRAY[
    '#e879f9', '#facc15', '#a3e635', '#4ade80', '#fb923c', '#f472b6',
    '#c084fc', '#93c5fd', '#bef264', '#67e8f9', '#fda4af', '#d8b4fe',
    '#fdba74', '#86efac', '#fde047', '#5eead4', '#c4b5fd', '#f9a8d4',
    '#7dd3fc', '#d9f99d', '#f0abfc', '#fed7aa', '#bbf7d0', '#fef08a'
  ];
  reserved text[] := ARRAY[
    '#2dd4bf', '#38bdf8', '#a78bfa', '#fb7185', '#f59e0b',
    '#34d399', '#22d3ee', '#818cf8', '#f97316', '#94a3b8'
  ];
  item record;
  candidate text;
  ordinal int;
BEGIN
  FOR item IN
    SELECT id, row_number() OVER (ORDER BY name, id)::int AS ordinal
    FROM agent_roles
    WHERE kind = 'role' AND ui_color IS NULL
    ORDER BY name, id
  LOOP
    ordinal := item.ordinal;
    LOOP
      candidate := CASE
        WHEN ordinal <= cardinality(palette) THEN palette[ordinal]
        ELSE deepsonar_role_generated_color(ordinal)
      END;
      EXIT WHEN NOT (lower(candidate) = ANY(reserved))
        AND NOT EXISTS (
          SELECT 1 FROM agent_roles occupied
          WHERE occupied.kind = 'role' AND lower(occupied.ui_color) = lower(candidate)
        );
      ordinal := ordinal + 1;
    END LOOP;
    UPDATE agent_roles SET ui_color = lower(candidate), updated_at = now() WHERE id = item.id;
  END LOOP;
END;
$$;

DROP FUNCTION deepsonar_role_generated_color(int);

CREATE UNIQUE INDEX agent_roles_role_ui_color_uniq
  ON agent_roles (lower(ui_color))
  WHERE kind = 'role' AND ui_color IS NOT NULL;

-- Preserve frozen role colors in L0 canvas delta projections.  Full node
-- details remain available through the normal canvas endpoint.
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
      'ui_color', body->>'ui_color',
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
