import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DashboardUsage, type UsagePeriod } from "./api";
import { useAuth } from "./auth";
import { formatTrendDay } from "./dashboard-overview";
import { humanInterventionUiPrefUserKey } from "./human-messages";
import { formatTokenCount } from "./session-viewer/parseAgentSession";
import {
  USAGE_PERIOD_OPTIONS,
  defaultCustomRange,
  readUsageLedgerCollapsed,
  shanghaiYmd,
  usageEmpty,
  usageLedgerPageKey,
  writeUsageLedgerCollapsed,
} from "./usage-ledger";

type Scope = "global" | "project" | "task";
type TokenRow = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export function UsageLedgerBoard({
  scope = "global",
  projectId,
  canvasId,
}: {
  scope?: Scope;
  projectId?: string;
  canvasId?: string;
}) {
  const { me } = useAuth();
  const userKey = humanInterventionUiPrefUserKey(me);
  const pageKey = usageLedgerPageKey(scope, projectId, canvasId);
  const initialCustom = useMemo(() => defaultCustomRange(), []);
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const [customFrom, setCustomFrom] = useState(initialCustom.from);
  const [customTo, setCustomTo] = useState(initialCustom.to);
  const [usage, setUsage] = useState<DashboardUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => readUsageLedgerCollapsed(userKey, pageKey));

  useEffect(() => {
    setCollapsed(readUsageLedgerCollapsed(userKey, pageKey));
  }, [userKey, pageKey]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeUsageLedgerCollapsed(userKey, pageKey, next);
  }

  useEffect(() => {
    if (period === "custom" && (!customFrom || !customTo || customFrom > customTo)) {
      setUsage(null);
      setError(customFrom && customTo ? "开始日期不能晚于结束日期" : "请选择开始与结束日期");
      setLoading(false);
      return;
    }
    let stop = false;
    const query = period === "custom"
      ? { period, from: customFrom, to: customTo, project_id: projectId, canvas_id: canvasId }
      : { period, project_id: projectId, canvas_id: canvasId };
    setLoading(true);
    api.dashboardUsage(query)
      .then((board) => {
        if (stop) return;
        setUsage(board);
        setError(null);
        setLoading(false);
      })
      .catch((cause) => {
        if (stop) return;
        setError(String(cause));
        setLoading(false);
      });
    return () => { stop = true; };
  }, [period, customFrom, customTo, projectId, canvasId]);

  const peak = Math.max(1, ...(usage?.series.map((day) => day.total_tokens) ?? [0]));
  const title = scope === "task" ? "本任务用量账本" : scope === "project" ? "项目账本" : "用量账本";
  const hint = scope === "task"
    ? "只统计挂在本画布上的 Gateway 账本，不对账 Session 归档，也不计价。"
    : scope === "project"
      ? "按本项目 Job 的 Gateway 账本聚合；自定义时间为 Asia/Shanghai 日历日。"
      : "全局 Gateway 账本按日 / 周 / 月或自定义时间查看，可下钻到项目与任务。";

  return (
    <section className={`usage-ledger surface-shell${collapsed ? " is-collapsed" : ""}`}>
      <div className="surface-core usage-ledger__core">
        <div className="usage-ledger__head">
          <div>
            <div className="eyebrow"><span style={{ background: "#75cfff" }} />USAGE LEDGER</div>
            <h2>{title}</h2>
            <p>{hint}</p>
          </div>
          <div className="usage-ledger__toolbar">
            {!collapsed && (
              <div className="usage-ledger__periods" role="tablist" aria-label="用量时间范围">
                {USAGE_PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={period === option.value}
                    className={period === option.value ? "is-active" : ""}
                    onClick={() => setPeriod(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="usage-ledger__toggle"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "展开账本" : "收起账本"}
              onClick={toggleCollapsed}
            >
              <CaretDown size={12} className={collapsed ? "is-collapsed" : ""} />
              {collapsed ? "展开" : "收起"}
            </button>
          </div>
        </div>

        {collapsed ? (
          <p className="usage-ledger__note">
            {usage
              ? `${usage.totals.requests} 请求 · 合计 ${formatTokenCount(usage.totals.total_tokens)} · 缓存读 ${formatTokenCount(usage.totals.cache_read_input_tokens ?? 0)}`
              : loading ? "正在汇总账本…" : "账本已收起"}
          </p>
        ) : (
          <>
            {period === "custom" && (
              <div className="usage-ledger__custom">
                <label>
                  <span>开始日期</span>
                  <input className="usage-ledger__date" type="date" value={customFrom} max={customTo || shanghaiYmd()} onChange={(event) => setCustomFrom(event.target.value)} />
                </label>
                <label>
                  <span>结束日期</span>
                  <input className="usage-ledger__date" type="date" value={customTo} min={customFrom} max={shanghaiYmd()} onChange={(event) => setCustomTo(event.target.value)} />
                </label>
                <small>按北京时间日历日，含首尾，最长 366 天。</small>
              </div>
            )}

            {error && <p className="usage-ledger__error">{error}</p>}
            {loading && !usage && <p className="usage-ledger__note">正在汇总账本…</p>}

            {usage && (
              <>
                <dl className="usage-ledger__totals">
                  <UsageStat label="请求" value={String(usage.totals.requests)} />
                  <UsageStat label="输入" value={formatTokenCount(usage.totals.input_tokens)} raw={usage.totals.input_tokens} />
                  <UsageStat label="输出" value={formatTokenCount(usage.totals.output_tokens)} raw={usage.totals.output_tokens} />
                  <UsageStat label="缓存读" value={formatTokenCount(usage.totals.cache_read_input_tokens ?? 0)} raw={usage.totals.cache_read_input_tokens ?? 0} />
                  <UsageStat label="缓存写" value={formatTokenCount(usage.totals.cache_creation_input_tokens ?? 0)} raw={usage.totals.cache_creation_input_tokens ?? 0} />
                  <UsageStat label="合计" value={formatTokenCount(usage.totals.total_tokens)} raw={usage.totals.total_tokens} />
                  <UsageStat label="Job" value={String(usage.totals.jobs)} />
                  {scope === "global" && <UsageStat label="项目" value={String(usage.totals.projects)} />}
                  {scope !== "task" && <UsageStat label="任务" value={String(usage.totals.tasks)} />}
                </dl>
                <p className="usage-ledger__note">
                  {usage.range.days[0]} → {usage.range.days.at(-1)} · {usage.calendar_timezone}
                  {usage.totals.unknown || usage.totals.not_reported
                    ? ` · unknown ${usage.totals.unknown} · 未上报 ${usage.totals.not_reported}`
                    : ""}
                </p>

                {usageEmpty(usage) ? (
                  <p className="usage-ledger__empty">该时间范围内没有 Gateway 用量行。</p>
                ) : (
                  <>
                    <div className="usage-ledger__series" aria-label="按日消耗">
                      {usage.series.map((day) => (
                        <div key={day.date} className="usage-ledger__col" title={`${day.date} · ${day.total_tokens} tokens`}>
                          <div className="usage-ledger__bar">
                            <span style={{ height: `${Math.max(2, (day.total_tokens / peak) * 72)}px` }} />
                          </div>
                          <small>{formatTrendDay(day.date)}</small>
                        </div>
                      ))}
                    </div>

                    <div className={`usage-ledger__tables${scope === "global" ? " is-global" : ""}`}>
                      {scope === "global" && (
                        <UsageTable
                          title="项目"
                          empty="该窗口没有项目消耗"
                          rows={usage.projects.map((item) => ({
                            key: item.id,
                            name: item.name,
                            href: `/projects/${item.id}/usage`,
                            meta: `${item.jobs} Job · ${item.tasks} 任务`,
                            tokens: item,
                          }))}
                        />
                      )}
                      {scope !== "task" && (
                        <UsageTable
                          title="任务"
                          empty="该窗口没有任务消耗"
                          rows={usage.tasks.map((item) => ({
                            key: item.canvas_id ?? item.title,
                            name: item.title,
                            href: item.canvas_id ? `/projects/${item.project_id}/tasks/${item.canvas_id}` : `/projects/${item.project_id}/usage`,
                            meta: `${item.project_name} · ${item.jobs} Job`,
                            tokens: item,
                          }))}
                        />
                      )}
                      <UsageTable
                        title="模型"
                        empty="该窗口没有模型拆分"
                        rows={usage.models.map((item) => ({
                          key: `${item.provider}:${item.model}`,
                          name: `${item.provider} / ${item.model}`,
                          meta: `${item.requests} 次请求`,
                          tokens: item,
                        }))}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function UsageStat({ label, value, raw }: { label: string; value: string; raw?: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={raw == null ? undefined : String(raw)}>{value}</dd>
    </div>
  );
}

function UsageTable({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    key: string;
    name: string;
    href?: string;
    meta: string;
    tokens: TokenRow;
  }>;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="usage-ledger__empty">{empty}</p> : (
        <table>
          <thead>
            <tr>
              <th>{title}</th>
              <th>请求</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存读</th>
              <th>缓存写</th>
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.href ? <Link to={row.href}>{row.name}</Link> : row.name}
                  <small>{row.meta}</small>
                </td>
                <td>{row.tokens.requests}</td>
                <td>{formatTokenCount(row.tokens.input_tokens)}</td>
                <td>{formatTokenCount(row.tokens.output_tokens)}</td>
                <td>{formatTokenCount(row.tokens.cache_read_input_tokens ?? 0)}</td>
                <td>{formatTokenCount(row.tokens.cache_creation_input_tokens ?? 0)}</td>
                <td>{formatTokenCount(row.tokens.total_tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
