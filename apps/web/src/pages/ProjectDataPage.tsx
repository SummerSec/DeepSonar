import { useParams } from "react-router-dom";
import { TransferPanel } from "../TransferPanel";
import { PageHeader } from "../ui";

/**
 * 项目数据模块：本项目的 .deepsonarpack 导入/导出。
 * 平台级配置请到「平台数据与调度」。
 */
export function ProjectDataPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-7 sm:px-9 sm:pt-9">
        <PageHeader
          title="项目数据"
          eyebrow="PROJECT DATA"
          subtitle="导出或导入本项目的配置与任务历史。全局规则与平台配置包请到平台数据与调度处理。"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 sm:px-9">
        <div className="mx-auto max-w-2xl">
          <TransferPanel projectId={projectId} scope="project" />
        </div>
      </div>
    </div>
  );
}
