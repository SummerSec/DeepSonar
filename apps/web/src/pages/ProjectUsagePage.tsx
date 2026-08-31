import { useParams } from "react-router-dom";
import { UsageLedgerBoard } from "../UsageLedgerBoard";

/** 项目账本：复用看板，不再作为任务工作台顶部的独立区块。 */
export function ProjectUsagePage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return (
    <div className="page-scroll">
      <UsageLedgerBoard scope="project" projectId={projectId} />
    </div>
  );
}
