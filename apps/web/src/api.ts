/** 调度器 API 类型与请求（vite proxy /api → :3100） */

export interface Project {
  id: string;
  plane_project_id: string;
  canvas_id: string;
  name: string;
}

export interface CanvasNode {
  id: string;
  node_type: "root" | "job" | "finding" | "note" | "human";
  title: string;
  body_json: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
  status: string | null;
  job_id: string | null;
  updated_at: string;
}

export interface CanvasEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: "child" | "produces" | "verifies" | "next";
}

export interface CanvasData {
  canvas_id: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface JobEvent {
  id: string;
  job_seq: number;
  type: string;
  payload_json: Record<string, unknown>;
  created_at: string;
}

export interface JobDetail {
  job: {
    id: string;
    type: string;
    status: string;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  };
  events: JobEvent[];
  findings: { id: string; severity: string; title: string; verify_status: string }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  projects: () => get<Project[]>("/projects"),
  canvas: (projectId: string) => get<CanvasData>(`/projects/${projectId}/canvas`),
  job: (jobId: string) => get<JobDetail>(`/jobs/${jobId}`),
};
