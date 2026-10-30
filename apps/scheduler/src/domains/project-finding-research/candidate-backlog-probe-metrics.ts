/** Probe-only reporting; no production queue or ranking behavior. */
export interface BacklogSample {
  phase: string; tick: number; elapsed_ms: number; worker_ms: number; requested_wait_ms: number; actual_wait_ms: number;
  processed: number; total_sources: number; recorded_sources: number; pending_sources: number;
  status: string; generation: string; active_generation: string | null; cursor_id: string | null;
}
export function summarizeBacklog(samples: BacklogSample[]) {
  if (!samples.length) throw new Error('EMPTY_BACKLOG_SAMPLES');
  const first = samples[0], last = samples.at(-1)!;
  if (samples.some(s => s.generation !== first.generation || s.total_sources !== first.total_sources
    || s.recorded_sources + s.pending_sources !== s.total_sources || s.pending_sources < 0)) throw new Error('INCONSISTENT_BACKLOG_SAMPLES');
  for (let n = 1; n < samples.length; n++) {
    if (samples[n].pending_sources > samples[n - 1].pending_sources) throw new Error('BACKLOG_INCREASE_WITHIN_STATIC_GENERATION');
  }
  const published = samples.find(s => s.status === 'succeeded' && s.active_generation === s.generation);
  const measuredMs = last.elapsed_ms - first.elapsed_ms;
  return {
    generation: first.generation, complete: Boolean(published && published.pending_sources === 0),
    publication_elapsed_ms: published?.elapsed_ms ?? null, wall_ms: measuredMs,
    worker_ms: samples.reduce((n, s) => n + s.worker_ms, 0),
    actual_tick_wait_ms: samples.reduce((n, s) => n + s.actual_wait_ms, 0),
    recorded_source_delta: last.recorded_sources - first.recorded_sources,
    sources_per_wall_second: measuredMs > 0 ? (last.recorded_sources - first.recorded_sources) * 1000 / measuredMs : null,
    remaining_sources: last.pending_sources,
  };
}
export function counterDelta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(Object.keys(before).map(key => {
    if (!Number.isFinite(before[key]) || !Number.isFinite(after[key]) || after[key] < before[key]) throw new Error('INVALID_OR_RESET_DATABASE_COUNTER');
    return [key, after[key] - before[key]];
  }));
}
