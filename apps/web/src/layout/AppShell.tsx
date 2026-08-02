import { Bug, ChartBar, Check, Crosshair, Folder, Gear, MagnifyingGlass, Moon, Palette, Queue, Robot, SidebarSimple, Sun, X } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { DeepFlowMark } from "../components/DeepFlowMark";

const NAV: { to: string; end: boolean; label: string; caption: string; icon: Icon }[] = [
  { to: "/", end: true, label: "态势", caption: "全局风险与运行", icon: ChartBar },
  { to: "/projects", end: false, label: "项目", caption: "审计工作空间", icon: Folder },
  { to: "/findings", end: false, label: "发现", caption: "跨项目证据", icon: Bug },
  { to: "/jobs", end: false, label: "运行", caption: "调度与恢复", icon: Queue },
  { to: "/agents", end: false, label: "Agent", caption: "角色与能力", icon: Robot },
];
const PROJECT_TABS: { seg: string; label: string; caption: string; icon: Icon }[] = [
  { seg: "tasks", label: "任务工作台", caption: "意图与交付闭环", icon: Crosshair },
  { seg: "findings", label: "项目发现", caption: "风险证据", icon: Bug },
  { seg: "settings", label: "项目策略", caption: "角色与规则覆盖", icon: Gear },
];

const ACCENT_THEMES = [
  { id: "mint", label: "翡翠夜幕", caption: "默认深色精密仪器", color: "#65e6b4", surface: "#0b0e10", scheme: "dark" },
  { id: "arctic", label: "极地蓝", caption: "冷静深色技术界面", color: "#78bfff", surface: "#0b0e10", scheme: "dark" },
  { id: "lime", label: "荧光青柠", caption: "高对比深色作业台", color: "#b8df68", surface: "#0b0e10", scheme: "dark" },
  { id: "titanium", label: "钛金属", caption: "低彩度深色专注模式", color: "#c6d0d5", surface: "#0b0e10", scheme: "dark" },
  { id: "porcelain", label: "瓷白日光", caption: "清晰克制的亮色工作台", color: "#087a63", surface: "#f4f1ea", scheme: "light" },
] as const;
type AccentTheme = (typeof ACCENT_THEMES)[number]["id"];

function initialAccentTheme(): AccentTheme {
  const stored = localStorage.getItem("dfh:accent-theme");
  return ACCENT_THEMES.some((theme) => theme.id === stored) ? stored as AccentTheme : "mint";
}

function MainNav({ projectId, onNavigate }: { projectId?: string; onNavigate?: () => void }) {
  return <nav className="app-nav" aria-label="主导航"><div className="nav-group-label">WORKSPACE</div>{NAV.map((item) => <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate} title={item.label} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`}><span className="nav-icon"><item.icon size={17} weight="light" /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.caption}</small></span><i aria-hidden="true" /></NavLink>)}{projectId && <div className="project-nav"><div className="nav-group-label">CURRENT PROJECT</div>{PROJECT_TABS.map((item) => <NavLink key={item.seg} to={`/projects/${projectId}/${item.seg}`} onClick={onNavigate} title={item.label} className={({ isActive }) => `nav-item compact ${isActive ? "is-active" : ""}`}><span className="nav-icon"><item.icon size={16} weight="light" /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.caption}</small></span><i aria-hidden="true" /></NavLink>)}</div>}</nav>;
}

export function AppShell() {
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectId = projectMatch?.params.projectId;
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("dfh:rail") === "collapsed");
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initialAccentTheme);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => { localStorage.setItem("dfh:rail", collapsed ? "collapsed" : "expanded"); }, [collapsed]);
  useEffect(() => {
    const selected = ACCENT_THEMES.find((theme) => theme.id === accentTheme) ?? ACCENT_THEMES[0];
    document.documentElement.dataset.accentTheme = accentTheme;
    document.documentElement.dataset.colorScheme = selected.scheme;
    localStorage.setItem("dfh:accent-theme", accentTheme);
  }, [accentTheme]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen((value) => !value); }
      if (event.key === "Escape") { setCommandOpen(false); setMenuOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <div className="app-frame">
    <a href="#main-content" className="skip-link">跳到主要内容</a><div className="ambient-field" aria-hidden="true" />
    <aside className={`desktop-rail surface-shell ${collapsed ? "is-collapsed" : ""}`}><div className="rail-core surface-core"><div className="brand-lockup"><div className="brand-mark"><DeepFlowMark /></div><div className="brand-copy"><strong>DeepFlowHunter</strong><span>LOOP GRAPH ENGINEERING</span></div><button className="rail-collapse" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开导航" : "收起导航"} title={collapsed ? "展开导航" : "收起导航"}><SidebarSimple size={15} weight="light" /></button></div>
      <ThemePicker value={accentTheme} collapsed={collapsed} onChange={setAccentTheme} />
      <button className="command-trigger" onClick={() => setCommandOpen(true)} title="打开命令菜单"><MagnifyingGlass size={15} weight="light" /><span>搜索与跳转</span><kbd>⌘ K</kbd></button>
      <MainNav projectId={projectId} />
      <div className="rail-status"><span className="dfh-live-dot" /><div><strong>Scheduler online</strong><small>状态每 5 秒同步</small></div></div>
    </div></aside>

    <header className="mobile-island"><div className="brand-lockup compact"><div className="brand-mark"><DeepFlowMark /></div><div className="brand-copy"><strong>DeepFlowHunter</strong><span>深度流式猎手</span></div></div><button className="mobile-search" onClick={() => setCommandOpen(true)} aria-label="搜索与跳转"><MagnifyingGlass size={17} weight="light" /></button><button className={`menu-trigger ${menuOpen ? "is-open" : ""}`} onClick={() => setMenuOpen((value) => !value)} aria-label={menuOpen ? "关闭导航" : "打开导航"} aria-expanded={menuOpen}><span /><span /></button></header>
    <div className={`mobile-menu ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}><div className="mobile-menu-head"><span>CONTROL PLANE</span><button onClick={() => setMenuOpen(false)} aria-label="关闭"><X size={18} /></button></div><MainNav projectId={projectId} onNavigate={() => setMenuOpen(false)} /><div className="mobile-menu-foot"><span className="dfh-live-dot" /> 调度器在线</div></div>
    {commandOpen && <CommandMenu projectId={projectId} onClose={() => setCommandOpen(false)} onNavigate={(to) => { navigate(to); setCommandOpen(false); }} />}
    <main id="main-content" className="app-stage"><Outlet /></main>
  </div>;
}

function ThemePicker({ value, collapsed, onChange }: { value: AccentTheme; collapsed: boolean; onChange: (theme: AccentTheme) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = ACCENT_THEMES.find((theme) => theme.id === value) ?? ACCENT_THEMES[0];
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div ref={rootRef} className={`theme-picker ${open ? "is-open" : ""}`}>
    <button type="button" className="theme-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="listbox" title="切换控制台主题">
      {selected.scheme === "light" ? <Sun size={16} weight="light" /> : <Moon size={16} weight="light" />}
      {!collapsed && <><span><strong>外观主题</strong><small>{selected.label}</small></span><i style={{ background: selected.color }} /></>}
    </button>
    {open && <div className="theme-popover" role="listbox" aria-label="控制台外观主题">
      <header><span><Palette size={14} weight="light" /></span><div><strong>控制台外观</strong><small>完整配色方案 · 即时保存</small></div></header>
      {ACCENT_THEMES.map((theme) => <button key={theme.id} type="button" role="option" aria-selected={theme.id === value} className={theme.id === value ? "is-selected" : ""} onClick={() => { onChange(theme.id); setOpen(false); }}>
        <span className="theme-swatch" style={{ background: theme.surface }}><i style={{ background: theme.color }} /></span>
        <span><strong>{theme.label}</strong><small>{theme.caption}</small></span>
        {theme.id === value && <Check size={14} weight="bold" />}
      </button>)}
    </div>}
  </div>;
}

function CommandMenu({ projectId, onClose, onNavigate }: { projectId?: string; onClose: () => void; onNavigate: (to: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => [
    ...NAV.map((item) => ({ label: item.label, caption: item.caption, to: item.to, icon: item.icon, group: "全局" })),
    ...(projectId ? PROJECT_TABS.map((item) => ({ label: item.label, caption: item.caption, to: `/projects/${projectId}/${item.seg}`, icon: item.icon, group: "当前项目" })) : []),
  ], [projectId]);
  const filtered = commands.filter((item) => `${item.label}${item.caption}${item.group}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => setActive(0), [query]);
  return <div className="command-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="command-panel" role="dialog" aria-modal="true" aria-label="搜索与跳转"><div className="command-input"><MagnifyingGlass size={18} weight="light" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, filtered.length - 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); } if (event.key === "Enter" && filtered[active]) onNavigate(filtered[active].to); }} placeholder="搜索页面、任务入口或配置…" aria-label="搜索命令" /><kbd>ESC</kbd></div><div className="command-results">{filtered.length ? filtered.map((item, index) => <button key={item.to} className={index === active ? "is-active" : ""} onMouseEnter={() => setActive(index)} onClick={() => onNavigate(item.to)}><span className="command-icon"><item.icon size={16} weight="light" /></span><span><strong>{item.label}</strong><small>{item.caption}</small></span><em>{item.group}</em></button>) : <div className="command-empty">没有匹配的入口</div>}</div><footer><span>↑↓ 选择</span><span>↵ 打开</span><span>Esc 关闭</span></footer></section></div>;
}
