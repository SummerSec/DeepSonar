-- Issue #43: versioned per-Finding reports, separate from the task-level report.
CREATE TABLE finding_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  canvas_id text NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  version integer NOT NULL,
  report_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  input_uri text NOT NULL,
  input_sha256 text NOT NULL,
  summary_json jsonb NOT NULL DEFAULT '{}',
  markdown_uri text,
  markdown_sha256 text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finding_reports_version_check CHECK (version >= 1),
  CONSTRAINT finding_reports_status_check
    CHECK (status IN ('pending', 'generating', 'succeeded', 'failed')),
  UNIQUE (finding_id, version)
);
CREATE INDEX finding_reports_finding_idx ON finding_reports (finding_id, version DESC);
CREATE INDEX finding_reports_project_idx ON finding_reports (project_id, created_at DESC);
CREATE UNIQUE INDEX finding_reports_one_active_idx
  ON finding_reports (finding_id) WHERE status IN ('pending', 'generating');
