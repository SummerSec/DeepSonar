import { Link } from "react-router-dom";
import type { AuthMe } from "../api";
import { canAccessAnyScope } from "../permissions";

/** Project controls remain in the platform image catalog. */
export function ProjectRuntimeImageAuthority({ projectId, me }: { projectId: string; me: AuthMe | null }) {
  const canReadImages = canAccessAnyScope(me, ["images:read"])
    && (!me?.actor?.project_id || me.actor.project_id === projectId);
  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">运行镜像权威</div>
      </div>
      <div className="space-y-2 px-4 py-4 text-[13px] leading-6 text-zinc-400">
        <p>项目不再选择或绑定运行镜像。Job 缺省镜像跟随平台全局 RoleConfig；Hub 可通过 <code className="text-zinc-300">list_available_runtime_images</code> 从平台可信/就绪/CLI 兼容目录提案，创建时冻结不可变 digest。</p>
        <p>官方镜像默认可用（<code className="text-zinc-300">deepsonar-base</code> 永不可停用；其它官方可在平台「镜像」页按项目排除）。第三方须平台绑定可见项目后由项目启用。版本永远跟随平台 channel 最新，项目不能钉版本。</p>
        {canReadImages && (
          <Link className="secondary-button inline-flex" to={`/images?project_id=${encodeURIComponent(projectId)}`}>
            管理本项目可用镜像
          </Link>
        )}
      </div>
    </section>
  );
}
