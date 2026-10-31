import assert from 'node:assert/strict';
import test from 'node:test';
import { runCandidateBacklogProbe } from './candidate-backlog-probe.js';

test('real isolated backlog probe publishes, stops/resumes and rebuilds changed sources', {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const report=await runCandidateBacklogProbe(process.env.TEST_DATABASE_URL!,30,1);
  assert.equal(report.phases.length,2);
  assert.equal(report.input_distribution.sources,30);
  assert.equal(report.input_distribution.jobs,30);
  assert.equal(report.rebuilt_sources,31);
  for(const phase of report.phases){
    assert.equal(phase.summary.complete,true);assert.equal(phase.summary.remaining_sources,0);
    assert.ok(phase.summary.wall_ms>0);assert.ok(phase.summary.actual_tick_wait_ms>0);
    assert.equal(phase.samples[0].recorded_sources,0);
    assert.equal(phase.samples.at(-1)!.recorded_sources,phase.samples[0].total_sources);
  }
  assert.ok(report.pause);assert.ok(report.pause.before.pending_sources>0);
  assert.equal(report.pause.before.pending_sources,report.pause.after.pending_sources);
  assert.equal(report.pause.before.cursor_id,report.pause.after.cursor_id);
  assert.equal(report.source_change.invalidated_status,'stale');assert.equal(report.source_change.invalidated_items,0);
  assert.equal(report.source_change.new_generation_published,true);
  assert.ok(report.database_resources.after.database_bytes>0);
  assert.equal(report.database_resources.after.relations.length,4);
  assert.ok(report.database_resources.after.indexes.length>=4);
  assert.ok(report.database_resources.after.observed_connections>=1);
  assert.ok(report.database_resources.delta.xact_commit>0);
  assert.ok(!JSON.stringify(report).includes(process.env.TEST_DATABASE_URL!));
});
