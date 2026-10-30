import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function buildReplayReport(baselineBytes, rows, provenance) {
  const baseline=JSON.parse(baselineBytes);
  if(baseline.schema!=='deepsonar.plan-offline-baseline/v1' || !/^[a-f0-9]{40}$/.test(baseline.baseline_commit)
    || !Array.isArray(baseline.cases) || !baseline.cases.length || !Array.isArray(baseline.modes) || !baseline.modes.length
    || baseline.modes.some(mode=>!['inline','file'].includes(mode)) || baseline.cases.some(c=>!c || typeof c.id!=='string' || typeof c.category!=='string' || !c.expected || typeof c.expected!=='object' || Array.isArray(c.expected))
    || new Set(baseline.modes).size!==baseline.modes.length || new Set(baseline.cases.map(c=>c.id)).size!==baseline.cases.length) throw new Error('Invalid frozen baseline');
  const expected=new Map(baseline.modes.flatMap(mode=>baseline.cases.map(c=>[`${mode}:${c.id}`,{mode,...c}])));
  const observed=new Map(),invalid=[];
  for(const row of rows){
    const key=`${row?.mode}:${row?.id}`;
    if(!expected.has(key) || !row?.observed || typeof row.observed!=='object' || Array.isArray(row.observed)) { invalid.push('unknown_or_invalid_case');continue; }
    if(observed.has(key)){invalid.push(`duplicate:${key}`);continue;}
    observed.set(key,row.observed);
  }
  const cases=[...expected].map(([key,c])=>({mode:c.mode,id:c.id,category:c.category,expected:c.expected,
    observed:observed.get(key)??null,status:!observed.has(key)?'missing':isDeepStrictEqual(observed.get(key),c.expected)?'match':'different'}));
  const matched=cases.filter(c=>c.status==='match').length;
  const metrics=Object.fromEntries([...new Set(cases.map(c=>c.category))].map(category=>{
    const group=cases.filter(c=>c.category===category), measured=group.filter(c=>c.status!=='missing');
    return [category,{expected_cases:group.length,observed_cases:measured.length,matching_cases:group.filter(c=>c.status==='match').length,
      differing_cases:group.filter(c=>c.status==='different').length,missing_cases:group.length-measured.length}];
  }));
  const completionCases=cases.filter(c=>c.category==='unproven_completion');
  const humanCases=cases.filter(c=>c.category==='human_stop');
  const control_observations={
    deliberately_unproven_completion:{expected:completionCases.length,observed:completionCases.filter(c=>c.observed).length,
      accepted:completionCases.filter(c=>c.observed?.http_status===200).length,
      rejected_as_unproven:completionCases.filter(c=>c.observed?.http_status===422 && c.observed?.error_code==='plan_completion_unproven').length},
    requested_human_stops:{expected:humanCases.length,observed:humanCases.filter(c=>c.observed).length,
      waiting_human:humanCases.filter(c=>c.observed?.job_status==='waiting_human').length},
  };
  return {schema:'deepsonar.plan-offline-report/v1',scope:baseline.scope,
    baseline:{commit:baseline.baseline_commit,sha256:createHash('sha256').update(baselineBytes).digest('hex')},
    provenance,passed:matched===cases.length && !invalid.length && provenance.exit_code===0,
    denominator:{expected:cases.length,observed:observed.size,matched,missing:cases.length-observed.size},invalid,
    metrics,control_observations,cases,unmeasured:baseline.unmeasured.map(metric=>({metric,value:null,reason:'not_measured_by_control_replay'})),
    interpretation:'Synthetic offline control regression only; no measured model-quality improvement and no C-stage activation evidence.'};
}
