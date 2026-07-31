/**
 * Plane Cloud API 客户端（见 docs/PLANE_NOTES.md）
 * - 认证：X-API-Key（workspace 级 token）
 * - 所有端点以 /api/v1/workspaces/{slug} 为根
 */

export interface PlaneClientOptions {
  baseUrl: string; // https://api.plane.so
  token: string;
  workspaceSlug: string;
}

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
}

export interface PlaneState {
  id: string;
  name: string;
  group: string; // backlog / unstarted / started / completed / cancelled
}

export interface PlaneIssue {
  id: string;
  name: string;
  description_html?: string;
  state: string; // state id
  project: string;
  priority?: string;
}

export class PlaneClient {
  constructor(private opts: PlaneClientOptions) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.baseUrl}/api/v1/workspaces/${this.opts.workspaceSlug}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": this.opts.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Plane ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // Plane 列表端点返回 { grouped_by, results: [...] } 分页结构
  private async list<T>(path: string): Promise<T[]> {
    const data = await this.req<{ results?: T[] } | T[]>("GET", path);
    if (Array.isArray(data)) return data;
    return data.results ?? [];
  }

  listProjects(): Promise<PlaneProject[]> {
    return this.list<PlaneProject>("/projects/");
  }

  listStates(projectId: string): Promise<PlaneState[]> {
    return this.list<PlaneState>(`/projects/${projectId}/states/`);
  }

  listIssues(projectId: string): Promise<PlaneIssue[]> {
    return this.list<PlaneIssue>(`/projects/${projectId}/issues/`);
  }

  getIssue(projectId: string, issueId: string): Promise<PlaneIssue> {
    return this.req<PlaneIssue>("GET", `/projects/${projectId}/issues/${issueId}/`);
  }

  updateIssueState(projectId: string, issueId: string, stateId: string): Promise<void> {
    return this.req("PATCH", `/projects/${projectId}/issues/${issueId}/`, { state: stateId });
  }

  addComment(projectId: string, issueId: string, commentHtml: string): Promise<void> {
    return this.req("POST", `/projects/${projectId}/issues/${issueId}/comments/`, {
      comment_html: commentHtml,
    });
  }

  /** state 名称 → id 映射（如 Ready / In Progress / Done） */
  async stateMap(projectId: string): Promise<Map<string, string>> {
    const states = await this.listStates(projectId);
    return new Map(states.map((s) => [s.name, s.id]));
  }
}

/**
 * 从 issue 描述中解析任务参数。
 * 约定（见 ARCHITECTURE §4.1）：描述内含 `type=audit_module`、`path=auth/` 等键值对。
 * description_html 先去标签再按行解析 key=value。
 */
export function parseIssueTask(issue: PlaneIssue): { type?: string; params: Record<string, string> } {
  const text = (issue.description_html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const params: Record<string, string> = {};
  let type: string | undefined;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([a-z_]+)\s*=\s*(.+)$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === "type") type = value.trim();
    else params[key.toLowerCase()] = value.trim();
  }
  return { type, params };
}
