import assert from 'node:assert/strict';
import test from 'node:test';
import { counterDelta, summarizeBacklog, type BacklogSample } from './candidate-backlog-probe-metrics.js';

// Arithmetic fixtures only, never emitted as measured performance evidence.
const sample = (changes: Partial<BacklogSample> = {}): BacklogSample => ({phase:'unit',tick:0,elapsed_ms:0,worker_ms:0,
  requested_wait_ms:0,actual_wait_ms:0,processed:0,total_sources:5,recorded_sources:0,pending_sources:5,
  status:'pending',generation:'g1',active_generation:null,cursor_id:null,...changes});
test('backlog summary distinguishes drained source rows from committed generation publication', () => {
  const initial=sample(),drained=sample({tick:1,elapsed_ms:100,worker_ms:80,actual_wait_ms:20,processed:5,recorded_sources:5,pending_sources:0,status:'running'});
  assert.equal(summarizeBacklog([initial,drained]).complete,false);
  const published=sample({...drained,tick:2,elapsed_ms:125,worker_ms:5,actual_wait_ms:20,processed:0,status:'succeeded',active_generation:'g1'});
  const result=summarizeBacklog([initial,drained,published]);
  assert.equal(result.complete,true);assert.equal(result.publication_elapsed_ms,125);assert.equal(result.sources_per_wall_second,40);
  assert.equal(result.worker_ms,85);assert.equal(result.actual_tick_wait_ms,40);
});
test('backlog summary rejects changing cohorts or generations and counter resets', () => {
  assert.throws(()=>summarizeBacklog([]),/EMPTY/);
  assert.throws(()=>summarizeBacklog([sample(),sample({generation:'g2'})]),/INCONSISTENT/);
  assert.throws(()=>summarizeBacklog([sample({pending_sources:0,recorded_sources:5}),sample()]),/INCREASE/);
  assert.deepEqual(counterDelta({hits:4,reads:2},{hits:7,reads:2}),{hits:3,reads:0});
  assert.throws(()=>counterDelta({hits:4},{hits:1}),/RESET/);
  assert.throws(()=>counterDelta({hits:4},{hits:NaN}),/INVALID/);
});
