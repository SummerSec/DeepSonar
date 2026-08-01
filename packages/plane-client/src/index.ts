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

/** Plane issue 描述转纯文本。人只写标题和内容，调度参数由系统与 Agent 决定。 */
export function issueContent(issue: PlaneIssue): string {
  return (issue.description_html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
