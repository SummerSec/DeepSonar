#!/usr/bin/env node
/** Runs inside the real, limited, native deepsonar-reverse image. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertEvidence, ghidraProfile, sha256, exactProcedureAddresses, selectUniqueFixtureProcedure } from './reverse-native-common.mjs';
import { nativeArch, supportedNodeVersion } from './reverse-toolchain-check.mjs';
import { measuredCommand, cgroupMemory, processTable, providerProcesses, sanitizeProcess } from './reverse-native-process.mjs';

const directory='/workspace/reverse-evidence';
mkdirSync(directory,{recursive:true});
const [arch]=process.argv.slice(2);
const report={ schema:'deepsonar.reverse.native-container/v1', passed:false, architecture:arch, checks:{native_architecture:false,toolchain:false,commands:false,cancellation:false,memory:false}, queries:[] };
const save=()=>writeFileSync(join(directory,'container-measurements.json'),JSON.stringify(report,null,2)+'\n');
const run=async (name,command,args,options={}) => {
  const value=await measuredCommand({name,command,args,directory,...options});
  report.queries.push(value.record); save(); return value;
};
try {
  assert.equal(process.platform,'linux'); assert.equal(nativeArch(process.arch),arch);
  assert(supportedNodeVersion(process.versions.node));
  report.checks.native_architecture=true;
  assert.equal(process.env.GHIDRA_HEADLESS_MAXMEM,'1536m','test must measure shipped production JVM limit');
  report.cgroup_memory=cgroupMemory();
  await run('preflight','reverse-env.sh',['--check']);
  const doctor=JSON.parse((await run('doctor','rea',['doctor','--provider','ghidra','--json'])).output);
  assert.equal(doctor.healthy,true,'REA scoped Ghidra doctor must be healthy');
  assert.equal(doctor.identity.cli_package_version,'6.4.0');
  const help=(await run('trace_help','rea',['trace-native-values','--help'])).output;
  for (const flag of ['--max-depth','--max-functions','--max-call-sites','--max-nodes','--max-edges']) assert(help.includes(flag));
  report.toolchain={rea_agents:'6.4.0',ghidra:'12.1.4',node:process.versions.node,java_home:process.env.JAVA_HOME,ghidra_headless_maxmem:process.env.GHIDRA_HEADLESS_MAXMEM,manifest:JSON.parse(readFileSync('/opt/deepsonar/tool-manifest.json','utf8'))};
  const os=arch==='amd64'?'linux_x86_64':'linux_arm_64';
  report.toolchain.native_decompiler=JSON.parse(readFileSync(`/opt/deepsonar/ghidra/Ghidra/Features/Decompiler/os/${os}/decompile.provenance.json`,'utf8'));
  report.checks.toolchain=true; save();
  // Validate against this exact installed REA version's actual public schemas.
  const pkg='/opt/deepsonar/rea/node_modules/rea-agents/dist';
  const {evidenceSchema}=await import(`${pkg}/domain/evidence.js`);
  const {functionDossierSchema}=await import(`${pkg}/domain/hopperValues.js`);
  const {nativeValueTraceSchema}=await import(`${pkg}/domain/native/nativeValueTrace.js`);
  const {analysisViewResultSchema}=await import(`${pkg}/domain/analysisView/analysisView.js`);
  const samples=JSON.parse(readFileSync('/inputs/samples.json','utf8'));
  report.samples=samples;
  const execute=async (name,sample,command,selector,operation,extra=[])=>{
    const target=`/inputs/${sample.name}`;
    assert.equal(sha256(readFileSync(target)),sample.sha256);
    const args=[command,target,...(selector?[selector]:[]),'--provider','ghidra','--json',...extra];
    const value=JSON.parse((await run(name,'rea',args)).output);
    const result=assertEvidence(value,{operation,sample,evidenceSchema});
    return {value,result};
  };
  const overview=result=>{
    assert(result.segment_count>0 && result.procedure_count>0,'empty binary overview');
    assert(Array.isArray(result.segments)&&result.segments.length>0);
  };
  const dossier=result=>{
    assert(functionDossierSchema.safeParse(result).success,'invalid function dossier');
    assert(result.pseudocode.length>0 && result.assembly.length>0,'missing native pseudocode/assembly');
    selectUniqueFixtureProcedure([result.procedure],'vulnerable_copy');
  };
  const elf=samples.find(sample=>sample.name==='sample_elf');
  const snapshot=join(directory,'elf-snapshot.json');
  const cold=await execute('cold_analyze',elf,'analyze',null,'binary_overview',['--snapshot',snapshot]);
  overview(cold.result);
  const repeat=await execute('repeat_analyze_with_snapshot',elf,'analyze',null,'binary_overview',['--snapshot',snapshot]);
  overview(repeat.result);
  assert.equal(repeat.value.evidence_id,cold.value.evidence_id,'exact repeated query snapshot evidence differs');
  const fn=await execute('different_query_function',elf,'function','vulnerable_copy','analyze_function',['--snapshot',snapshot]);
  dossier(fn.result);
  const found=(await execute('search_procedure',elf,'search','vulnerable_copy','search_procedures',['--kind','procedures'])).result;
  assert(Array.isArray(found)&&found.some(item=>/vulnerable_copy/.test(item.value??item.name??'')),'procedure search returned no fixture match');
  const pseudo=(await execute('decompile',elf,'decompile','vulnerable_copy','procedure_pseudo_code')).result;
  assert(typeof pseudo==='string'&&pseudo.length>0,'empty pseudocode');
  const instructions=(await execute('instructions',elf,'instructions','vulnerable_copy','read_function_instructions')).result;
  assert(Array.isArray(instructions.instructions)&&instructions.instructions.length>0,'empty instructions');
  const xrefs=(await execute('xrefs',elf,'xrefs',fn.result.procedure.address,'xrefs')).result;
  assert(Array.isArray(xrefs)&&xrefs.length>0,'called fixture function has no xrefs');
  const trace=(await execute('trace_native_values',elf,'trace-native-values','secret_sum','trace_native_values',['--max-depth','0','--max-functions','1','--max-call-sites','32','--max-nodes','5000','--max-edges','10000','--limit','1000'])).result;
  assert(nativeValueTraceSchema.safeParse(trace).success,'invalid native value trace');
  assert(trace.nodes.length>0&&trace.decompilations===1,'empty/unbounded native value trace');
  assert.equal(trace.truncated,false,'truncated fixture trace cannot count as complete smoke');
  const viewPath=join(directory,'view-input.json');
  writeFileSync(viewPath,JSON.stringify({source:{kind:'inline',evidence:fn.value},view:{kind:'native',facet:'value_flow_summary',offset:0,limit:32}})+'\n');
  const view=JSON.parse((await run('inspect_analysis_view','rea',['inspect-analysis-view',viewPath,'--json'])).output);
  assert(evidenceSchema.safeParse(view).success); assert.equal(view.operation,'inspect_analysis_view');
  assert.equal(view.subject.digest.sha256,elf.sha256);
  assert.equal(view.provider.id,'rea-analysis-view');
  assert(analysisViewResultSchema.safeParse(view.normalized_result).success,'invalid selected native view');
  assert.equal(view.normalized_result.parent_evidence_id,fn.value.evidence_id);
  assert.equal(view.normalized_result.kind,'native');
  assert.equal(view.normalized_result.item.available,true,'native value-flow view unavailable');
  assert(view.normalized_result.item.operations>0,'native value-flow view has no operations');
  for (const sample of samples.filter(sample=>sample!==elf)) {
    overview((await execute(`${sample.name}_analyze`,sample,'analyze',null,'binary_overview')).result);
    const search=await execute(`${sample.name}_search_procedure`,sample,'search','vulnerable_copy','search_procedures',['--kind','procedures','--mode','literal','--case-sensitive']);
    const candidates=[];
    for (const [index,address] of exactProcedureAddresses(search.result,'vulnerable_copy').entries()) {
      const candidate=await execute(`${sample.name}_candidate_${index}_function`,sample,'function',address,'analyze_function');
      assert(functionDossierSchema.safeParse(candidate.result).success,'invalid candidate function dossier');
      assert.equal(candidate.result.procedure.address,address,'candidate function entry differs from search address');
      candidates.push(candidate);
    }
    const selected=selectUniqueFixtureProcedure(candidates.map(candidate=>candidate.result.procedure),'vulnerable_copy');
    const fn=candidates.find(candidate=>candidate.result.procedure.address===selected.address);
    dossier(fn.result);
    report.procedure_selections??=[];
    report.procedure_selections.push({sample:sample.name,name:selected.name,address:selected.address,search_evidence_id:search.value.evidence_id,candidate_evidence_ids:candidates.map(candidate=>candidate.value.evidence_id),selected_evidence_id:fn.value.evidence_id,classification:selected.classification,body:selected.body});
    save();
  }
  report.checks.commands=true; save();
  // No snapshot; a distinct source path guarantees a new Ghidra import to interrupt.
  copyFileSync('/inputs/sample_elf',join(directory,'cancel_elf'));
  await run('cancel_sigterm_mid_analyze','rea',['analyze',join(directory,'cancel_elf'),'--provider','ghidra','--json'],{cancel:true});
  const residual=providerProcesses(processTable());
  writeFileSync(join(directory,'final-processes.json'),JSON.stringify(processTable().map(sanitizeProcess),null,2)+'\n');
  assert.equal(residual.length,0,'provider processes remain after cancellation');
  report.checks.cancellation=true;
  report.cgroup_memory=cgroupMemory();
  report.checks.memory=true; report.passed=true;
} catch (error) {
  report.failure={message:error.message,stack:error.stack};
  process.exitCode=1;
} finally { save(); }
console.log(JSON.stringify({passed:report.passed,checks:report.checks,failure:report.failure?.message}));
