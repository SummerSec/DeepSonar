import { useParams, useSearchParams } from "react-router-dom";
import {
  PROJECT_DELIVERY_EYEBROW,
  PROJECT_DELIVERY_TITLE,
  readProjectDeliveryPanel,
  writeProjectDeliveryPanel,
  type ProjectDeliveryPanel,
} from "../findings-risk-desk";
import { PageHeader } from "../ui";
import { FindingsPage } from "./FindingsPage";
import { ProjectReportsPage } from "./ProjectReportsPage";

const PANELS: { id: ProjectDeliveryPanel; label: string; caption: string }[] = [
  { id: "risk", label: "风险", caption: "发现列表与汇总" },
  { id: "reports", label: "报告", caption: "交付物与生成状态" },
];

/** 项目级风险发现 + 报告聚合的统一交付台（#561）。 */
export function ProjectDeliveryPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const panel = readProjectDeliveryPanel(searchParams);

  if (!projectId) return null;

  const setPanel = (next: ProjectDeliveryPanel) => {
    setSearchParams(writeProjectDeliveryPanel(searchParams, next), { replace: true });
  };

  return (
    <div className="page-scroll">
      <PageHeader
        title={PROJECT_DELIVERY_TITLE}
        eyebrow={PROJECT_DELIVERY_EYEBROW}
      />
      <nav
        className="theme-surface mb-4 inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full p-1 [scrollbar-width:none]"
        role="tablist"
        aria-label="风险与报告分区"
      >
        {PANELS.map((item) => {
          const active = panel === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={item.caption}
              onClick={() => setPanel(item.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] transition-colors ${
                active
                  ? "theme-chip text-zinc-100"
                  : "text-zinc-600 hover:bg-white/[.04] hover:text-zinc-300"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      {panel === "reports" ? (
        <ProjectReportsPage embedded />
      ) : (
        <FindingsPage scope="project" hidePageChrome />
      )}
    </div>
  );
}
