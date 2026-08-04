import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleNotch,
  LockKey,
  ShieldWarning,
  Sparkle,
  Target,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Project } from "../api";
import { useAuth } from "../auth";
import {
  errorMessage,
  hasQuickStartWritePermission,
  isPermissionError,
  LAST_PROJECT_STORAGE_KEY,
  networkOverrideLabel,
  NEW_PROJECT,
  QUICK_START_PRESETS,
  readinessFailures,
  runQuickStart,
  type NetworkOverride,
} from "../dashboard-quick-start";
import { PrimaryButton } from "../ui";

interface DashboardLaunchRailProps {
  projects: Project[];
  onProjectCreated?: (project: Project) => void;
}

type LaunchStage = "describe" | "preflight" | "handoff";

function readLastProjectId(): string {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberProject(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    /* private mode / blocked storage */
  }
}

function isExternalHref(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href);
}

function StepRail({ stage }: { stage: LaunchStage }) {
  const current = stage === "describe" ? 0 : stage === "preflight" ? 1 : 2;
  const steps = ["描述目标", "预检", "进入画布"];
  return (
    <ol className="intent-launch-steps" aria-label="开始任务进度">
      {steps.map((label, index) => (
        <li key={label} className={index < current ? "is-complete" : index === current ? "is-current" : ""}>
          <span className="intent-launch-step-mark" aria-hidden="true">{index < current ? <Check size={11} weight="bold" /> : `0${index + 1}`}</span>
          <span>{label}</span>
          {index < steps.length - 1 && <span className="intent-launch-step-line" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export function DashboardLaunchRail({ projects, onProjectCreated }: DashboardLaunchRailProps) {
  const navigate = useNavigate();
  const { status, me } = useAuth();
  const activeProjects = useMemo(() => projects.filter((project) => project.status === "active"), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [preset, setPreset] = useState<(typeof QUICK_START_PRESETS)[number]["id"]>("custom");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [networkOverride, setNetworkOverride] = useState<NetworkOverride>("inherit");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [stage, setStage] = useState<LaunchStage>("describe");
  const [busy, setBusy] = useState(false);
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof api.readiness>> | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const canStart = hasQuickStartWritePermission(status, me);
  const selectedProject = activeProjects.find((project) => project.id === selectedProjectId) ?? null;
  const isCreatingProject = selectedProjectId === NEW_PROJECT || !activeProjects.length;
  const permissionLoading = status === null && me === null;

  useEffect(() => {
    if (selectedProjectId === NEW_PROJECT && !activeProjects.length) return;
    if (selectedProjectId && (selectedProjectId === NEW_PROJECT || activeProjects.some((project) => project.id === selectedProjectId))) return;
    const remembered = readLastProjectId();
    const preferred = activeProjects.find((project) => project.id === remembered) ?? activeProjects[0];
    setSelectedProjectId(preferred?.id ?? NEW_PROJECT);
  }, [activeProjects, selectedProjectId]);

  const selectProject = (id: string) => {
    setSelectedProjectId(id);
    setReadiness(null);
    setOperationError(null);
    setTechnicalError(null);
    setPermissionDenied(false);
  };

  const choosePreset = (id: (typeof QUICK_START_PRESETS)[number]["id"]) => {
    const selected = QUICK_START_PRESETS.find((item) => item.id === id);
    if (!selected) return;
    setPreset(id);
    setTitle(selected.title);
    setGoal(selected.goal);
    setOperationError(null);
    setTechnicalError(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!canStart) {
      setPermissionDenied(true);
      return;
    }
    setBusy(true);
    setStage("preflight");
    setReadiness(null);
    setOperationError(null);
    setTechnicalError(null);
    setPermissionDenied(false);
    const creatingProject = isCreatingProject;
    let createdProject: Project | null = null;
    try {
      const result = await runQuickStart(
        {
          title,
          goal,
          project: creatingProject ? null : selectedProject,
          newProject: creatingProject ? { name: newProjectName, description: newProjectDescription } : null,
          networkOverride,
        },
        {
          createProject: async (input) => {
            const project = await api.createProject(input);
            createdProject = project;
            onProjectCreated?.(project);
            setSelectedProjectId(project.id);
            return project;
          },
          readiness: api.readiness,
          createTask: api.createTask,
        },
      );

      if (result.kind === "invalid") {
        setOperationError(result.message);
        setTechnicalError(null);
        setStage("describe");
        return;
      }
      if (result.kind === "readiness_failed") {
        setReadiness(result.readiness);
        return;
      }
      rememberProject(result.project.id);
      setStage("handoff");
      navigate(`/projects/${result.project.id}/tasks/${result.task.canvas_id}?handoff=1`);
    } catch (error) {
      if (isPermissionError(error)) {
        setPermissionDenied(true);
      } else {
        setOperationError(
          createdProject
            ? "任务未创建，刚创建的项目已保留，可修复后重试。"
            : creatingProject
              ? "项目尚未创建，任务也未创建，请修复后重试。"
              : "任务未创建，请稍后重试。",
        );
        setTechnicalError(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const failures = readiness ? readinessFailures(readiness) : [];

  return (
    <section className="intent-launch-rail surface-shell deepsonar-reveal" aria-labelledby="intent-launch-title">
      <div className="intent-launch-core surface-core">
        <div className="intent-launch-header">
          <div>
            <div className="eyebrow"><span style={{ background: "var(--accent)" }} />QUICK START / INTENT LAUNCH</div>
            <h2 id="intent-launch-title">从一句目标开始</h2>
            <p>只描述你想解决的事情。Hub、角色、凭据与运行时由平台预检并决定，快捷入口不会绕过治理边界。</p>
          </div>
          <div className="intent-launch-signal" aria-hidden="true"><Sparkle size={22} weight="light" /><span>LOCAL TRUTH</span></div>
        </div>

        <StepRail stage={stage} />

        {permissionLoading ? (
          <div className="intent-launch-permission" role="status"><CircleNotch size={17} className="animate-spin" /><span>正在确认当前账号的任务权限…</span></div>
        ) : permissionDenied || !canStart ? (
          <div className="intent-launch-permission is-denied" role="alert">
            <span className="intent-launch-permission-icon"><LockKey size={18} weight="light" /></span>
            <div><strong>当前账号不能开始任务</strong><p>需要项目写入与任务写入权限。请切换到 operator/admin 账号，或让管理员调整访问范围。</p><Link to="/settings" className="intent-launch-inline-link">查看设置 <ArrowUpRight size={13} /></Link></div>
          </div>
        ) : (
          <form className="intent-launch-form" onSubmit={submit}>
            <div className="intent-launch-form-grid">
              <div className="intent-launch-field intent-launch-field-wide">
                <label htmlFor="quick-start-title">任务标题 <span>必填</span></label>
                <input id="quick-start-title" value={title} onChange={(event) => { setTitle(event.target.value); setPreset("custom"); }} maxLength={200} placeholder="例如：确认登录边界是否存在越权路径" required autoComplete="off" />
              </div>
              <div className="intent-launch-field intent-launch-field-wide">
                <label htmlFor="quick-start-goal">目标与背景 <span>必填</span></label>
                <textarea id="quick-start-goal" value={goal} onChange={(event) => { setGoal(event.target.value); setPreset("custom"); }} maxLength={20_000} rows={4} placeholder="告诉平台要解决什么、已知边界是什么，以及什么证据能让你相信结果。" required />
              </div>
            </div>

            <div className="intent-launch-presets" aria-label="目标预设">
              <span className="intent-launch-field-caption">快速填入意图</span>
              <div className="intent-launch-preset-list">
                {QUICK_START_PRESETS.map((item) => <button key={item.id} type="button" className={preset === item.id ? "is-selected" : ""} onClick={() => choosePreset(item.id)}>{item.label}</button>)}
              </div>
              <span className="intent-launch-preset-note">预设只填充标题与目标，不会选择角色、镜像或凭据。</span>
            </div>

            <div className="intent-launch-form-grid intent-launch-context-grid">
              <div className="intent-launch-field">
                <label htmlFor="quick-start-project">项目空间 <span>默认归属</span></label>
                <select id="quick-start-project" value={selectedProjectId || NEW_PROJECT} onChange={(event) => selectProject(event.target.value)}>
                  {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  <option value={NEW_PROJECT}>{activeProjects.length ? "＋ 新建一个项目空间" : "＋ 现在创建第一个项目空间"}</option>
                </select>
                <small>{selectedProject ? `上次使用或当前默认 · ${selectedProject.name}` : "没有可用项目，将在这里创建一个本地项目空间"}</small>
              </div>
              {isCreatingProject && <div className="intent-launch-field">
                <label htmlFor="quick-start-new-project">新项目名称 <span>必填</span></label>
                <input id="quick-start-new-project" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} maxLength={120} placeholder="例如：登录边界复核" required autoComplete="off" />
                <input className="intent-launch-secondary-input" value={newProjectDescription} onChange={(event) => setNewProjectDescription(event.target.value)} maxLength={500} placeholder="一句话说明（可选）" autoComplete="off" aria-label="项目说明，可选" />
              </div>}
            </div>

            <details className="intent-launch-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
              <summary><span><Target size={15} weight="light" />高级边界</span><strong>网络策略 · {networkOverrideLabel(networkOverride)}</strong></summary>
              <div className="intent-launch-advanced-body">
                <fieldset>
                  <legend>本次任务网络策略</legend>
                  {(["inherit", "allow", "deny"] as NetworkOverride[]).map((value) => <label key={value} className={networkOverride === value ? "is-selected" : ""}><input type="radio" name="quick-start-network" value={value} checked={networkOverride === value} onChange={() => setNetworkOverride(value)} /><span>{networkOverrideLabel(value)}</span></label>)}
                </fieldset>
                <p>默认继承项目设置。覆盖只写入本次任务快照，不能指定镜像、凭据或 Agent 角色。</p>
              </div>
            </details>

            {readiness && !readiness.ready && <div className="intent-launch-readiness" role="alert">
              <div className="intent-launch-alert-title"><ShieldWarning size={18} weight="light" /><div><strong>平台暂时不能启动这个任务</strong><span>预检发现 {failures.length} 项需要处理，项目已保留，你可以修复后重试。</span></div></div>
              <ul>{failures.slice(0, 5).map((check) => <li key={check.code}><WarningCircle size={14} weight="light" /><span><b>{check.message}</b>{check.fix && (isExternalHref(check.fix.href) ? <a href={check.fix.href} target="_blank" rel="noreferrer">{check.fix.target}<ArrowUpRight size={12} /></a> : <Link to={check.fix.href}>{check.fix.target}<ArrowUpRight size={12} /></Link>)}</span></li>)}</ul>
              {failures.length > 5 && <small>还有 {failures.length - 5} 项，请先处理上面的关键问题。</small>}
            </div>}

            {operationError && <div className="intent-launch-operation-error" role="alert"><WarningCircle size={16} weight="light" /><div><span>{operationError}</span>{technicalError && <details><summary>技术详情</summary><code>{technicalError}</code></details>}</div></div>}

            <div className="intent-launch-submit-row">
              <div><span className="intent-launch-submit-note"><span className="intent-launch-live-dot" />预检通过后才会创建任务与 Job</span><span className="intent-launch-submit-note">{networkOverrideLabel(networkOverride)}</span></div>
              <PrimaryButton type="submit" busy={busy} disabled={!canStart || permissionLoading}>{busy ? "检查并进入画布" : <><span>开始任务</span><ArrowRight size={15} weight="light" /></>}</PrimaryButton>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
