import { ArrowRight, Folder, LockKey, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Project, type ProjectImageStrategy } from "../api";
import { useAuth } from "../auth";
import {
  createProjectSpace,
  errorMessage,
  hasProjectWritePermission,
  isPermissionError,
} from "../dashboard-quick-start";
import { PrimaryButton } from "../ui";

interface NewProjectFormProps {
  onProjectCreated?: (project: Project) => void;
  onCancel?: () => void;
  canCancel?: boolean;
}

export function NewProjectForm({ onProjectCreated, onCancel, canCancel = false }: NewProjectFormProps) {
  const navigate = useNavigate();
  const { status, me } = useAuth();
  const instanceId = useId().replace(/:/g, "");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageStrategy, setImageStrategy] = useState<ProjectImageStrategy>("inherit_global");
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const canCreate = hasProjectWritePermission(status, me);
  const permissionLoading = status === null && me === null;

  useEffect(() => {
    if (!permissionLoading && canCreate) nameInputRef.current?.focus();
  }, [canCreate, permissionLoading]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!canCreate) {
      setPermissionDenied(true);
      return;
    }
    setBusy(true);
    setOperationError(null);
    setTechnicalError(null);
    setPermissionDenied(false);
    try {
      const result = await createProjectSpace(
        { name, description, imageStrategy },
        { createProject: api.createProject },
      );
      if (result.kind === "invalid") {
        setOperationError(result.message);
        return;
      }
      onProjectCreated?.(result.project);
      navigate(`/projects/${result.project.id}/tasks`);
    } catch (error) {
      if (isPermissionError(error)) {
        setPermissionDenied(true);
      } else {
        setOperationError("项目尚未创建，请修复后重试。");
        setTechnicalError(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="intent-launch-rail surface-shell deepsonar-reveal" aria-labelledby={`new-project-title-${instanceId}`}>
      <div className="intent-launch-core surface-core">
        <div className="intent-launch-header">
          <div>
            <div className="eyebrow"><span style={{ background: "var(--accent)" }} />PROJECT SPACE</div>
            <h2 id={`new-project-title-${instanceId}`}>创建一个项目空间</h2>
            <p>项目只定义长期边界：镜像策略、角色、凭据与证据。创建后不会铸造画布或派发 Hub，第一项任务可以稍后再下。</p>
          </div>
          <div className="intent-launch-signal" aria-hidden="true"><Folder size={22} weight="light" /><span>NO TASK YET</span></div>
        </div>

        {canCancel && onCancel && (
          <button type="button" className="intent-launch-cancel" onClick={onCancel} disabled={busy}>
            取消
          </button>
        )}

        {permissionLoading ? (
          <div className="intent-launch-permission" role="status">正在确认当前账号的项目权限…</div>
        ) : permissionDenied || !canCreate ? (
          <div className="intent-launch-permission is-denied" role="alert">
            <span className="intent-launch-permission-icon"><LockKey size={18} weight="light" /></span>
            <div>
              <strong>当前账号不能创建项目</strong>
              <p>只需要项目写入权限。下达任务仍需要任务写入权限。</p>
              <Link to="/agents?tab=roles" className="intent-launch-inline-link">查看设置</Link>
            </div>
          </div>
        ) : (
          <form className="intent-launch-form" onSubmit={submit}>
            <div className="intent-launch-form-grid">
              <div className="intent-launch-field intent-launch-field-wide">
                <label htmlFor={`new-project-name-${instanceId}`}>项目名称 <span>必填</span></label>
                <input
                  ref={nameInputRef}
                  id={`new-project-name-${instanceId}`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  placeholder="例如：登录边界复核"
                  required
                  autoComplete="off"
                />
              </div>
              <div className="intent-launch-field intent-launch-field-wide">
                <label htmlFor={`new-project-description-${instanceId}`}>项目说明 <span>可选</span></label>
                <textarea
                  id={`new-project-description-${instanceId}`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="一句话说明长期边界，不必写成任务目标。"
                />
              </div>
            </div>

            <fieldset className="intent-launch-project-policy">
              <legend>项目镜像策略</legend>
              <label className={imageStrategy === "inherit_global" ? "is-selected" : ""}>
                <input type="radio" name={`new-project-image-strategy-${instanceId}`} value="inherit_global" checked={imageStrategy === "inherit_global"} onChange={() => setImageStrategy("inherit_global")} />
                <span><strong>继承全局</strong><small>各角色使用全局运行配置中的镜像。</small></span>
              </label>
              <label className={imageStrategy === "project_managed" ? "is-selected" : ""}>
                <input type="radio" name={`new-project-image-strategy-${instanceId}`} value="project_managed" checked={imageStrategy === "project_managed"} onChange={() => setImageStrategy("project_managed")} />
                <span><strong>项目托管</strong><small>在项目设置集中选择可信镜像，未选角色使用系统基础环境。</small></span>
              </label>
            </fieldset>

            {operationError && (
              <div className="intent-launch-operation-error" role="alert">
                <WarningCircle size={16} weight="light" />
                <div>
                  <span>{operationError}</span>
                  {technicalError && <details><summary>技术详情</summary><code>{technicalError}</code></details>}
                </div>
              </div>
            )}

            <div className="intent-launch-submit-row">
              <div>
                <span className="intent-launch-submit-note"><span className="intent-launch-live-dot" />不会创建任务、画布或 Job</span>
              </div>
              <PrimaryButton type="submit" busy={busy} disabled={!canCreate || permissionLoading}>
                {busy ? "正在创建项目" : <><span>创建项目</span><ArrowRight size={15} weight="light" /></>}
              </PrimaryButton>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
