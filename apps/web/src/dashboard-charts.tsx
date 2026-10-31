import type { DashboardPeriodCounts, DashboardTrendDay } from "./api";
import {
  donutSegments,
  formatTrendDay,
  stackedPercents,
  trendBarHeight,
  trendPeak,
  type DashboardSlice,
} from "./dashboard-overview";

const DONUT_SIZE = 132;
const DONUT_RADIUS = 46;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
const TREND_HEIGHT = 88;

function Legend({ slices, total }: { slices: readonly DashboardSlice[]; total: number }) {
  if (!slices.length) {
    return <p className="dashboard-chart-empty">暂无分布</p>;
  }
  return (
    <ul className="dashboard-chart-legend">
      {slices.map((slice) => (
        <li key={slice.key}>
          <span className="dashboard-swatch" style={{ background: slice.color }} />
          <span>{slice.label}</span>
          <strong>{slice.count}</strong>
          <small>{total ? Math.round((slice.count / total) * 100) : 0}%</small>
        </li>
      ))}
    </ul>
  );
}

export function DistributionChart({
  title,
  slices,
}: {
  title: string;
  slices: readonly DashboardSlice[];
}) {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  const segments = donutSegments(slices, DONUT_CIRCUMFERENCE);
  const stacked = stackedPercents(slices);
  return (
    <article className="dashboard-chart">
      <h3>{title}</h3>
      <div className="dashboard-chart-body">
        <svg className="dashboard-donut" viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`} role="img" aria-label={`${title} ${total}`}>
          <circle className="dashboard-donut-track" cx={DONUT_SIZE / 2} cy={DONUT_SIZE / 2} r={DONUT_RADIUS} />
          {segments.map((segment) => (
            <circle
              key={segment.key}
              cx={DONUT_SIZE / 2}
              cy={DONUT_SIZE / 2}
              r={DONUT_RADIUS}
              stroke={segment.color}
              strokeDasharray={`${segment.dash} ${DONUT_CIRCUMFERENCE - segment.dash}`}
              strokeDashoffset={segment.offset}
            />
          ))}
          <text x="50%" y="48%" textAnchor="middle">{total}</text>
          <text className="dashboard-donut-caption" x="50%" y="62%" textAnchor="middle">合计</text>
        </svg>
        <div className="dashboard-chart-side">
          <div className="dashboard-stacked" aria-hidden={stacked.length === 0}>
            {stacked.map((slice) => (
              <span key={slice.key} style={{ width: `${slice.percent}%`, background: slice.color }} title={`${slice.label} ${slice.count}`} />
            ))}
          </div>
          <Legend slices={slices} total={total} />
        </div>
      </div>
    </article>
  );
}

export function TrendChart({ days }: { days: readonly DashboardTrendDay[] }) {
  const peak = trendPeak(days);
  const series: Array<{ key: keyof DashboardPeriodCounts; label: string; color: string }> = [
    { key: "new_tasks", label: "新建任务", color: "#6fbbe8" },
    { key: "completed_tasks", label: "完成任务", color: "#65e6b4" },
    { key: "new_findings", label: "新增发现", color: "#ec8c5d" },
  ];
  return (
    <article className="dashboard-chart dashboard-trend">
      <div className="dashboard-trend-head">
        <h3>近 7 日趋势</h3>
        <ul>
          {series.map((item) => (
            <li key={item.key}><span className="dashboard-swatch" style={{ background: item.color }} />{item.label}</li>
          ))}
        </ul>
      </div>
      <div className="dashboard-trend-plot">
        {days.map((day) => (
          <div key={day.date} className="dashboard-trend-col">
            <div className="dashboard-trend-bars">
              {series.map((item) => (
                <span
                  key={item.key}
                  title={`${item.label} ${day[item.key]}`}
                  style={{ height: `${trendBarHeight(day[item.key], peak, TREND_HEIGHT)}px`, background: item.color }}
                />
              ))}
            </div>
            <small>{formatTrendDay(day.date)}</small>
          </div>
        ))}
      </div>
    </article>
  );
}
