import { Bug, CaretLeft, CaretRight, ChartBar, Check, Crosshair, Cube, Database, Folder, Gear, Key, MagnifyingGlass, Moon, Palette, Queue, Receipt, Robot, ShieldCheck, SignOut, Storefront, Sun, User, X } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { resolveRailAuthPresentation } from "../auth-status";
import { DeepSonarMark } from "../components/DeepSonarMark";
import { canAccessAnyScope } from "../permissions";
import { formatHealthOpenSandbox, healthOpenSandboxDegraded, type HealthOpenSandbox } from "../health-status";
import { formatHealthVersion, githubReleaseUrlForVersion } from "../product-version";

const WORKSPACE_NAV: { to: string; end: boolean; label: string; caption: string; icon: Icon }[] = [
  { to: "/", end: true, label: "态势", caption: "全局风险与运行", icon: ChartBar },
  { to: "/projects", end: false, label: "项目", caption: "审计工作空间", icon: Folder },
];
const CAPABILITY_NAV: { to: string; end: boolean; label: string; caption: string; icon: Icon; scopes: string[] }[] = [
  { to: "/agents", end: false, label: "Agent", caption: "角色与能力", icon: Robot, scopes: ["agents:read"] },
  { to: "/agent-market", end: false, label: "Agent 市场", caption: "模板与模块", icon: Storefront, scopes: ["agents:read"] },
  { to: "/images", end: false, label: "镜像", caption: "可信运行环境", icon: Cube, scopes: ["images:read"] },
];
const PLATFORM_NAV: { to: string; label: string; caption: string; icon: Icon; scopes: string[] }[] = [
  { to: "/settings/access", label: "安全与访问", caption: "账号、用户与 Token", icon: ShieldCheck, scopes: ["tokens:manage"] },
  { to: "/settings/credentials", label: "凭据", caption: "Provider 密钥边界", icon: Key, scopes: ["agents:read"] },
  { to: "/settings/platform", label: "配置中心", caption: "运行时护栏与调度", icon: Database, scopes: ["agents:read", "exports:read"] },
];
const SECONDARY_COMMANDS = [
  { label: "跨项目发现", caption: "全局证据检索", to: "/findings", icon: Bug, group: "跨项目检索" },
  { label: "跨项目运行", caption: "调度与恢复队列", to: "/jobs", icon: Queue, group: "跨项目检索" },
];
const PROJECT_TABS: { seg: string; label: string; caption: string; icon: Icon }[] = [
  { seg: "tasks", label: "任务工作台", caption: "意图与交付闭环", icon: Crosshair },
  { seg: "usage", label: "项目账本", caption: "用量与缓存命中", icon: Receipt },
  { seg: "findings", label: "项目风险", caption: "风险发现", icon: Bug },
  { seg: "data", label: "项目数据", caption: "导入与导出", icon: Folder },
  { seg: "settings", label: "项目策略", caption: "角色与规则覆盖", icon: Gear },
  { seg: "images", label: "项目镜像", caption: "启用与版本固定", icon: Cube },
];

const ACCENT_THEMES = [
  { id: "mint", label: "翡翠夜幕", caption: "默认深色精密仪器", color: "#65e6b4", surface: "#0b0e10", scheme: "dark" },
  { id: "arctic", label: "极地蓝", caption: "冷静深色技术界面", color: "#78bfff", surface: "#0b0e10", scheme: "dark" },
  { id: "lime", label: "荧光青柠", caption: "高对比深色作业台", color: "#b8df68", surface: "#0b0e10", scheme: "dark" },
  { id: "titanium", label: "钛金属", caption: "低彩度深色专注模式", color: "#c6d0d5", surface: "#0b0e10", scheme: "dark" },
  { id: "porcelain", label: "瓷白日光", caption: "暖白亮色工作台", color: "#087a63", surface: "#f3f1ec", scheme: "light" },
  { id: "mist", label: "雾白纸台", caption: "略沉冷白 · 比瓷白更收敛", color: "#3d6b8a", surface: "#e4e7ec", scheme: "light" },
] as const;
type AccentTheme = (typeof ACCENT_THEMES)[number]["id"];

function initialAccentTheme(): AccentTheme {
  const stored = localStorage.getItem("deepsonar:accent-theme");
  return ACCENT_THEMES.some((theme) => theme.id === stored) ? stored as AccentTheme : "mint";
}

type EscapeEventLike = {
  key: string;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

export function consumeAppShellEscape(
  event: EscapeEventLike,
  overlays: { commandOpen: boolean; menuOpen: boolean },
  closeCommand: () => void,
  closeMenu: () => void,
): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  if (overlays.commandOpen) {
    event.preventDefault();
    closeCommand();
    return true;
  }
  if (overlays.menuOpen) {
    event.preventDefault();
    closeMenu();
    return true;
  }
  return false;
}

function MainNav({ projectId, onNavigate }: { projectId?: string; onNavigate?: () => void }) {
  const { me } = useAuth();
  const capabilityNav = CAPABILITY_NAV.filter((item) => canAccessAnyScope(me, item.scopes));
  return <nav className="app-nav" aria-label="主导航"><div className="nav-group-label">WORKSPACE</div>{WORKSPACE_NAV.map((item) => <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate} title={item.label} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`}><span className="nav-icon"><item.icon size={17} weight="light" /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.caption}</small></span><i aria-hidden="true" /></NavLink>)}{capabilityNav.length > 0 && <div className="project-nav"><div className="nav-group-label">CAPABILITY</div>{capabilityNav.map((item) => <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate} title={item.label} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`}><span className="nav-icon"><item.icon size={17} weight="light" /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.caption}</small></span><i aria-hidden="true" /></NavLink>)}</div>}{projectId && <div className="project-nav"><div className="nav-group-label">CURRENT PROJECT</div>{PROJECT_TABS.map((item) => <NavLink key={item.seg} to={`/projects/${projectId}/${item.seg}`} onClick={onNavigate} title={item.label} className={({ isActive }) => `nav-item compact ${isActive ? "is-active" : ""}`}><span className="nav-icon"><item.icon size={16} weight="light" /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.caption}</small></span><i aria-hidden="true" /></NavLink>)}</div>}</nav>;
}

function useSchedulerHealth() {
  const [version, setVersion] = useState<string | null>(null);
  const [openSandbox, setOpenSandbox] = useState<HealthOpenSandbox | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      api.health()
        .then((health) => {
          if (cancelled) return;
          setVersion(formatHealthVersion(health.version));
          setOpenSandbox(health.opensandbox ?? null);
        })
        .catch(() => {
          if (!cancelled) setVersion((current) => current);
        });
    };
    tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return { version, openSandbox };
}

export function AppShell() {
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectId = projectMatch?.params.projectId;
  const schedulerHealth = useSchedulerHealth();
  const versionLabel = schedulerHealth.version ?? "—";
  const versionHref = githubReleaseUrlForVersion(schedulerHealth.version);
  const openSandboxLabel = formatHealthOpenSandbox(schedulerHealth.openSandbox);
  const statusLabel = openSandboxLabel ? `${versionLabel} · ${openSandboxLabel}` : versionLabel;
  const versionMark = versionHref ? (
    <a
      href={versionHref}
      target="_blank"
      rel="noreferrer noopener"
      className="rail-version-link"
      title="在 GitHub 查看此版本"
    >
      {versionLabel}
    </a>
  ) : versionLabel;
  const statusDegraded = healthOpenSandboxDegraded(schedulerHealth.openSandbox);
  const statusTitle = schedulerHealth.openSandbox?.domain
    ? `${statusLabel} · ${schedulerHealth.openSandbox.domain}`
    : statusLabel;
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const menuOpenRef = useRef(menuOpen);
  const commandOpenRef = useRef(commandOpen);
  menuOpenRef.current = menuOpen;
  commandOpenRef.current = commandOpen;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("deepsonar:rail") === "collapsed");
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initialAccentTheme);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => { localStorage.setItem("deepsonar:rail", collapsed ? "collapsed" : "expanded"); }, [collapsed]);
  useEffect(() => {
    const selected = ACCENT_THEMES.find((theme) => theme.id === accentTheme) ?? ACCENT_THEMES[0];
    document.documentElement.dataset.accentTheme = accentTheme;
    document.documentElement.dataset.colorScheme = selected.scheme;
    localStorage.setItem("deepsonar:accent-theme", accentTheme);
  }, [accentTheme]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen((value) => !value); }
      consumeAppShellEscape(
        event,
        { commandOpen: commandOpenRef.current, menuOpen: menuOpenRef.current },
        () => setCommandOpen(false),
        () => setMenuOpen(false),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <div className="app-frame">
    <a href="#main-content" className="skip-link">跳到主要内容</a><div className="ambient-field" aria-hidden="true" />
    <aside className={`desktop-rail surface-shell ${collapsed ? "is-collapsed" : ""}`}>
      <div className="rail-core surface-core">
        <div className="brand-lockup">
          <div className="brand-mark"><DeepSonarMark /></div>
          <div className="brand-copy">
            <strong>DeepSonar</strong>
            <span>LOOP GRAPH ENGINEERING</span>
          </div>
        </div>
        <ThemePicker value={accentTheme} collapsed={collapsed} onChange={setAccentTheme} />
        <button className="command-trigger" onClick={() => setCommandOpen(true)} title="打开命令菜单">
          <MagnifyingGlass size={15} weight="light" />
          <span>搜索与跳转</span>
          <kbd>⌘ K</kbd>
        </button>
        <MainNav projectId={projectId} />
        <UserRailFooter collapsed={collapsed} />
        <div className={`rail-status${statusDegraded ? " is-degraded" : ""}`} title={statusTitle}>
          <span className="deepsonar-live-dot" />
          <div>
            <strong>Scheduler online</strong>
            <small>{versionMark}{openSandboxLabel ? ` · ${openSandboxLabel}` : ""}</small>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="rail-collapse"
        onClick={() => setCollapsed((value) => !value)}
        aria-label={collapsed ? "展开导航" : "收起导航"}
        aria-expanded={!collapsed}
        title={collapsed ? "展开导航" : "收起导航"}
      >
        {collapsed ? <CaretRight size={18} weight="bold" /> : <CaretLeft size={18} weight="bold" />}
        <span className="rail-collapse-label">{collapsed ? "展开" : "收起"}</span>
      </button>
    </aside>

    <header className="mobile-island"><div className="brand-lockup compact"><div className="brand-mark"><DeepSonarMark /></div><div className="brand-copy"><strong>DeepSonar</strong><span>深流循迹</span></div></div><button className="mobile-search" onClick={() => setCommandOpen(true)} aria-label="搜索与跳转"><MagnifyingGlass size={17} weight="light" /></button><button className={`menu-trigger ${menuOpen ? "is-open" : ""}`} onClick={() => setMenuOpen((value) => !value)} aria-label={menuOpen ? "关闭导航" : "打开导航"} aria-expanded={menuOpen}><span /><span /></button></header>
    <div className={`mobile-menu ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}><div className="mobile-menu-head"><span>CONTROL PLANE</span><button onClick={() => setMenuOpen(false)} aria-label="关闭"><X size={18} /></button></div><MainNav projectId={projectId} onNavigate={() => setMenuOpen(false)} /><UserRailFooter collapsed={false} /><div className={`mobile-menu-foot${statusDegraded ? " is-degraded" : ""}`} title={statusTitle}><span className="deepsonar-live-dot" /> 调度器在线 {versionMark}{openSandboxLabel ? ` · ${openSandboxLabel}` : ""}</div></div>
    {commandOpen && <CommandMenu projectId={projectId} onClose={() => setCommandOpen(false)} onNavigate={(to) => { navigate(to); setCommandOpen(false); }} />}
    <main id="main-content" className="app-stage"><Outlet /></main>
  </div>;
}

function UserRailFooter({ collapsed }: { collapsed: boolean }) {
  const { user, me, loading, status, statusError, logout } = useAuth();
  const navigate = useNavigate();
  const railAuth = resolveRailAuthPresentation({ loading, status, error: statusError });
  if (railAuth.kind !== "session") {
    return (
      <div
        className={`rail-user ${railAuth.className}`}
        title={railAuth.title}
        role={railAuth.kind === "error" ? "alert" : undefined}
      >
        {!collapsed && <span>{railAuth.label}</span>}
        {collapsed && <span className="rail-user-dot" aria-hidden />}
        <button type="button" title="平台设置" className="rail-user-logout" onClick={() => navigate("/settings/access")}><Gear size={14} /></button>
      </div>
    );
  }
  const label = user?.display_name || user?.username || me?.actor?.name || "已登录";
  const role = user?.role || me?.actor?.role || me?.actor?.type || "";
  return (
    <div className={`rail-user ${collapsed ? "is-collapsed" : ""}`}>
      <User size={14} className="shrink-0 text-zinc-500" />
      {!collapsed && (
        <div className="rail-user-meta">
          <div className="truncate text-[11px] font-medium text-zinc-300">{label}</div>
          <div className="truncate font-mono text-[9px] text-zinc-600">{role}</div>
        </div>
      )}
      <button
        type="button"
        title="账号与安全"
        className="rail-user-logout"
        onClick={() => navigate("/settings/access?tab=account")}
      >
        <Gear size={14} />
      </button>
      <button
        type="button"
        title="退出登录"
        className="rail-user-logout"
        onClick={async () => {
          await logout();
          navigate("/login");
        }}
      >
        <SignOut size={14} />
      </button>
    </div>
  );
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
  const { me } = useAuth();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const capabilityNav = CAPABILITY_NAV.filter((item) => canAccessAnyScope(me, item.scopes));
  const platformNav = PLATFORM_NAV.filter((item) => canAccessAnyScope(me, item.scopes));
  const commands = useMemo(() => [
    ...WORKSPACE_NAV.map((item) => ({ label: item.label, caption: item.caption, to: item.to, icon: item.icon, group: "工作空间" })),
    ...capabilityNav.map((item) => ({ label: item.label, caption: item.caption, to: item.to, icon: item.icon, group: "能力" })),
    ...SECONDARY_COMMANDS,
    ...platformNav.map((item) => ({ ...item, group: "平台治理" })),
    ...(projectId ? PROJECT_TABS.map((item) => ({ label: item.label, caption: item.caption, to: `/projects/${projectId}/${item.seg}`, icon: item.icon, group: "当前项目" })) : []),
  ], [capabilityNav, platformNav, projectId]);
  const filtered = commands.filter((item) => `${item.label}${item.caption}${item.group}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => setActive(0), [query]);
  return (
    <div
      className="command-layer overflow-y-auto overscroll-contain"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="command-panel flex max-h-[calc(100dvh-2rem)] min-h-0 min-w-0 flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="搜索与跳转"
      >
        <div className="command-input min-w-0 shrink-0">
          <MagnifyingGlass size={18} weight="light" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, filtered.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              }
              if (event.key === "Enter" && filtered[active]) onNavigate(filtered[active].to);
            }}
            placeholder="搜索页面、任务入口或配置…"
            aria-label="搜索命令"
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-results min-h-0">
          {filtered.length ? (
            filtered.map((item, index) => (
              <button
                key={item.to}
                className={index === active ? "is-active" : ""}
                onMouseEnter={() => setActive(index)}
                onClick={() => onNavigate(item.to)}
              >
                <span className="command-icon"><item.icon size={16} weight="light" /></span>
                <span><strong>{item.label}</strong><small>{item.caption}</small></span>
                <em>{item.group}</em>
              </button>
            ))
          ) : (
            <div className="command-empty">没有匹配的入口</div>
          )}
        </div>
        <footer className="shrink-0 flex-wrap">
          <span>↑↓ 选择</span><span>↵ 打开</span><span>Esc 关闭</span>
        </footer>
      </section>
    </div>
  );
}
