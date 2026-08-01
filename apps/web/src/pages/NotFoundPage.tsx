import { ArrowLeft } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
  return <div className="page-scroll flex items-center justify-center"><section className="surface-shell w-full max-w-3xl"><div className="surface-core grid min-h-[460px] place-items-center p-8 text-center"><div><div className="mx-auto font-mono text-[82px] font-medium leading-none tracking-[-.08em] text-white/[.08]">404</div><div className="eyebrow mx-auto mt-[-12px]"><span />ROUTE NOT FOUND</div><h1 className="mt-6 text-3xl font-medium tracking-[-.04em] text-zinc-100">这条路径不属于当前工作区</h1><p className="mx-auto mt-3 max-w-md text-[12px] leading-6 text-zinc-500">页面可能已移动，或当前链接来自旧版本。返回运行态势可以继续处理现有项目和任务。</p><Link to="/" className="secondary-button mt-7 inline-flex items-center gap-2"><ArrowLeft size={14} weight="light" />返回运行态势</Link></div></div></section></div>;
}
