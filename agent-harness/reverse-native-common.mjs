/** Pure helpers for real Docker evidence; no mock output can satisfy a native run. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nativeArch } from './reverse-toolchain-check.mjs';

export const MIB = 1024 * 1024;
export const SIZE_CEILING_MIB = 2800;
export const LIMITS = Object.freeze({ memory_bytes: 4096 * MIB, cpu: 2, pids: 256, network: 'none', timeout_sec: 600 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function assertNativePlatform({ arch, hostPlatform, hostArch, daemonOs, daemonArch, imageOs, imageArch }) {
  assert(['amd64', 'arm64'].includes(arch), '--arch must be amd64 or arm64');
  assert.equal(hostPlatform, 'linux', 'native smoke requires a Linux host');
  assert.equal(daemonOs, 'linux', 'Docker daemon must be Linux');
  assert.equal(imageOs, 'linux', 'image must be Linux');
  for (const [kind, value] of [['host', hostArch], ['Docker daemon', daemonArch], ['image', imageArch]]) {
    assert.equal(nativeArch(value), arch, `${kind} architecture mismatch; QEMU is not native evidence`);
  }
}
export function compileSamples(source, output) {
  mkdirSync(output, { recursive: true });
  const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC', SOURCE_DATE_EPOCH: '1790007180' };
  const common = ['-O0', '-g', '-fno-inline', '-fno-builtin', '-ffile-prefix-map='+source+'=/src/sample.c', '-fdebug-prefix-map='+output+'=/build'];
  const specs = [
    {name:'sample_elf', format:'elf', compiler:'gcc', flags:['-Wl,--build-id=none', '-no-pie']},
    {name:'libsample.so', format:'elf', compiler:'gcc', flags:['-Wl,--build-id=none', '-fPIC', '-shared']},
    {name:'sample.exe', format:'pe', compiler:'x86_64-w64-mingw32-gcc', flags:['-Wl,--no-insert-timestamp']},
  ];
  return specs.map(spec => {
    const version = execFileSync(spec.compiler, ['--version'], {encoding:'utf8'}).split('\n')[0];
    const bytes = [];
    // Reuse the same absolute output name, so the test itself introduces no path differences.
    const path = join(output, spec.name);
    const args = [...common, ...spec.flags, source, '-o', path];
    for (let i=0; i<2; i++) {
      execFileSync(spec.compiler, args, { env, stdio:'pipe' });
      bytes.push(readFileSync(path));
    }
    assert(bytes[0].equals(bytes[1]), `${spec.name} fixture build is not reproducible`);
    assert(spec.format === 'pe' ? bytes[0].subarray(0,2).toString() === 'MZ' : bytes[0].subarray(0,4).equals(Buffer.from([127,69,76,70])), 'fixture format mismatch');
    return {name:spec.name, format:spec.format, sha256:sha256(bytes[0]), bytes:bytes[0].length, compiler:version, argv:args, reproducible:true};
  });
}
export function ghidraProfile(evidence) {
  let profile = evidence.analysis_profile;
  while (profile?.provider?.id === 'rea-workflow') profile = profile.parameters?.upstream_analysis_profile;
  assert.equal(profile?.provider?.id, 'ghidra', 'deep evidence must bind Ghidra');
  assert.equal(profile.provider.version, '12.1.4', 'Ghidra evidence version mismatch');
  return profile;
}
export function assertEvidence(evidence, { operation, sample, evidenceSchema }) {
  const result = evidenceSchema.safeParse(evidence);
  assert(result.success, `invalid REA Evidence: ${result.error?.message}`);
  assert.equal(evidence.operation, operation);
  assert.equal(evidence.subject?.digest?.sha256, sample.sha256, 'Evidence artifact hash mismatch');
  assert.equal(evidence.subject?.format, sample.format);
  ghidraProfile(evidence);
  return evidence.normalized_result;
}
/** Search names are discovery only. Later selectors must use provider-returned entry addresses. */
export function exactProcedureAddresses(results, name) {
  assert(Array.isArray(results), 'procedure search must return an inventory');
  const hits=results.filter(item=>item.value===name);
  for (const hit of hits) assert.match(hit.address,/^0x[0-9a-f]+$/, 'fixture procedure entry must be a canonical address');
  const addresses=[...new Set(hits.map(hit=>hit.address))].sort();
  assert(addresses.length>0, `no exact procedure named ${name}`);
  return addresses;
}
/** Do not silently choose the first symbol, a PLT thunk, an external, or an unknown identity. */
export function selectUniqueFixtureProcedure(procedures, name) {
  assert(Array.isArray(procedures), 'procedure candidates must be an inventory');
  for (const procedure of procedures) {
    assert.equal(procedure.name,name,'candidate procedure name differs from exact search');
    assert.match(procedure.address,/^0x[0-9a-f]+$/, 'fixture procedure entry must be a canonical address');
    assert.equal(typeof procedure.classification?.external,'boolean','unknown external classification');
    assert.equal(typeof procedure.classification?.thunk,'boolean','unknown thunk classification');
    assert.equal(procedure.classification.provenance,'ghidra-function-manager','classification must be Ghidra-backed');
  }
  const implementations=procedures.filter(procedure=>!procedure.classification.external&&!procedure.classification.thunk);
  assert.equal(implementations.length,1,`expected one nonexternal/nonthunk implementation of ${name}; found ${implementations.length}`);
  const selected=implementations[0];
  assert(selected.body?.available===true && selected.body.contains_entry===true && selected.body.total_bytes>0 && selected.body.ranges?.length>0,'selected fixture implementation must have a complete analyzed body');
  return selected;
}
