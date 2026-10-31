import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyPlatformSignatures, platformSignatureVerifyArgs, assertPlatformSignatureOutput} from './platform-upgrade-signature.mjs';
import {platformSignatureTarget, platformSignatureAnnotations, PLATFORM_SERVICES, sha256, COSIGN_VERSION} from './platform-upgrade-signature-contract.mjs';
import {createPlatformSignaturePlan} from '../agent-harness/platform-signature-plan.mjs';
const input = {version: '1.2.3', commit_sha: 'a'.repeat(40), schema_version: 61,
  images: Object.fromEntries(PLATFORM_SERVICES.map((s,i) => [s, `ghcr.io/summersec/deepsonar-${s}@sha256:${String(i+1).repeat(64)}`]))};
const target = platformSignatureTarget(input);
function payload(service='scheduler') {
  return {_type:'https://in-toto.io/Statement/v1',predicateType:'https://sigstore.dev/cosign/sign/v1',
    subject:[{digest:{sha256:target.images[service].split('@sha256:')[1]},annotations:platformSignatureAnnotations(target,service)}],predicate:{}};
}
function output(p) {return JSON.stringify({payloadType:'application/vnd.in-toto+json',payload:Buffer.from(JSON.stringify(p)).toString('base64'),signatures:[{sig:'fixture'}]});}
test('signature policy is opt-in and never returns unsigned success',async()=>{
  await assert.rejects(verifyPlatformSignatures({target:input}),{code:'signature_policy_disabled'});
  assert.throws(()=>createPlatformSignaturePlan({target:input}),{code:'signature_signing_disabled'});
});
test('stable release metadata and exact GHCR service references are required',()=>{
  for(const patch of [{version:'v1.2.3'},{version:'1.2.3-rc1'},{commit_sha:'main'},{schema_version:0},
    {images:{...input.images,scheduler:input.images.scheduler.replace('ghcr.io','docker.io')}},
    {images:{...input.images,scheduler:input.images.web}}]) assert.throws(()=>platformSignatureTarget({...input,...patch}));
});
test('signing plan binds full target metadata to exact tag workflow without requesting permissions',()=>{
  const github={repository:'SummerSec/DeepSonar',ref:target.ref,sha:target.commit_sha,workflow_ref:`SummerSec/DeepSonar/.github/workflows/release.yml@${target.ref}`};
  const plan=createPlatformSignaturePlan({enabled:true,target:input,github});assert.equal(plan.commands.length,3);
  assert.equal(plan.targetSha256,target.targetSha256);
  for(const row of plan.commands) assert.ok(row.args.includes(`deepsonar.target-sha256=${target.targetSha256}`));
  for(const patch of [{repository:'attacker/repo'},{ref:'refs/heads/main'},{sha:'b'.repeat(40)},{workflow_ref:'other.yml'}])
    assert.throws(()=>createPlatformSignaturePlan({enabled:true,target:input,github:{...github,...patch}}),{code:'signature_release_identity_mismatch'});
});
test('verify arguments require exact certificate identity, root and annotations without bypass flags',()=>{
  const args=platformSignatureVerifyArgs(target,'scheduler','/trusted/root.json');
  for(const value of [target.identity,target.ref,target.commit_sha,'--trusted-root','--check-claims=true'])assert.ok(args.includes(value));
  assert.equal(args.some(v=>/regexp|insecure|ignore|--key/.test(v)),false);
  assert.equal(args.at(-1),input.images.scheduler);
});
test('exit-zero output alone cannot authorize an image',()=>{
  for(const value of ['', '{}','[]','null','true','not json']) assert.throws(()=>assertPlatformSignatureOutput(value,target,'scheduler'));
  assert.equal(assertPlatformSignatureOutput(output(payload()),target,'scheduler').verifiedSignatures,1);
});
for(const key of ['deepsonar.repository','deepsonar.version','deepsonar.commit','deepsonar.schema','deepsonar.service','deepsonar.target-sha256']) {
  test(`reject wrong signed ${key}`,()=>{const p=payload();p.subject[0].annotations[key]='wrong';assert.throws(()=>assertPlatformSignatureOutput(output(p),target,'scheduler'),{code:'signature_claim_mismatch'});});
}
test('reject wrong repository, digest, type and mixed-target metadata even with other matching fields',()=>{
  for(const mutate of [p=>p.subject[0].annotations['deepsonar.repository']='ghcr.io/attacker/image',p=>p.subject[0].digest.sha256='f'.repeat(64),p=>p.predicateType='wrong']) {
    const p=payload();mutate(p);assert.throws(()=>assertPlatformSignatureOutput(output(p),target,'scheduler'));
  }
  const other=platformSignatureTarget({...input,images:{...input.images,web:input.images.web.replace('2'.repeat(64),'9'.repeat(64))}});
  assert.throws(()=>assertPlatformSignatureOutput(output(payload()),other,'scheduler'),{code:'signature_claim_mismatch'});
});
test('pinned subprocess verifies each service and rejects altered trust bytes / verifier failures',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pr747-signature-policy-'));
  try {
    const binary=join(dir,'verifier'),root=join(dir,'root');
    // Fake CLI tests transport and result handling only, not cryptographic/keyless verification.
    const script=`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='version'){console.log(JSON.stringify({gitVersion:'${COSIGN_VERSION}'}));}else if(a[0]==='sign'){if(!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)process.exit(5);}else{if(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)process.exit(6);if(Object.keys(process.env).some(k=>k.startsWith('COSIGN_')||k.startsWith('SIGSTORE_')))process.exit(4);const rows=${JSON.stringify(PLATFORM_SERVICES.map(s=>({ref:target.images[s],output:output(payload(s))})))};console.log(rows.find(r=>r.ref===a.at(-1)).output);}`;
    await writeFile(binary,script,{mode:0o700});await writeFile(root,'{}',{mode:0o600});
    const policy={enabled:true,cosignPath:binary,cosignSha256:sha256(script),trustedRootPath:root,trustedRootSha256:sha256('{}')};
    const result=await verifyPlatformSignatures({target:input,policy});assert.equal(result.verified,true);assert.equal(result.evidence.length,3);assert.equal(result.targetSha256,target.targetSha256);
    const {releasePlatformSignatures}=await import('../agent-harness/platform-signature-release.mjs');
    const environment={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'SummerSec/DeepSonar',GITHUB_REF:target.ref,GITHUB_SHA:target.commit_sha,
      GITHUB_WORKFLOW_REF:`SummerSec/DeepSonar/.github/workflows/release.yml@${target.ref}`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN:'isolated-fake-token',ACTIONS_ID_TOKEN_REQUEST_URL:'https://127.0.0.1/unused'};
    const signed=await releasePlatformSignatures({target:input,policy,execute:true,environment});
    assert.equal(signed.status,'signed_and_verified');assert.equal(signed.verification.targetSha256,target.targetSha256);
    await assert.rejects(verifyPlatformSignatures({target:input,policy:{...policy,trustedRootSha256:'a'.repeat(64)}}),{code:'signature_trust_hash_mismatch'});
    await assert.rejects(verifyPlatformSignatures({target:input,policy:{...policy,cosignSha256:'b'.repeat(64)}}),{code:'signature_trust_hash_mismatch'});
    const empty=`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='version')console.log(JSON.stringify({gitVersion:'${COSIGN_VERSION}'}));else if(a[0]!=='sign')console.log('[]');`;
    await writeFile(binary,empty,{mode:0o700});
    await assert.rejects(releasePlatformSignatures({target:input,policy:{...policy,cosignSha256:sha256(empty)},execute:true,environment}),{code:'signature_output_invalid'});
    const bad=`#!${process.execPath}\nconsole.error('do-not-leak');process.exit(3);`;await writeFile(binary,bad,{mode:0o700});
    await assert.rejects(verifyPlatformSignatures({target:input,policy:{...policy,cosignSha256:sha256(bad)}}),error=>error.code==='signature_verification_failed'&&!error.message.includes('do-not-leak'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('release execution cannot use caller-provided tag identity or proceed without OIDC authorization',async()=>{
  const {releasePlatformSignatures}=await import('../agent-harness/platform-signature-release.mjs');
  const github={repository:'SummerSec/DeepSonar',ref:target.ref,sha:target.commit_sha,workflow_ref:`SummerSec/DeepSonar/.github/workflows/release.yml@${target.ref}`};
  assert.equal((await releasePlatformSignatures({target:input,github})).status,'planned');
  await assert.rejects(releasePlatformSignatures({target:input,github,execute:true,environment:{}}),{code:'signature_release_identity_mismatch'});
  const environment={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:github.repository,GITHUB_REF:github.ref,GITHUB_SHA:github.sha,GITHUB_WORKFLOW_REF:github.workflow_ref};
  await assert.rejects(releasePlatformSignatures({target:input,execute:true,environment}),{code:'signature_oidc_permission_required'});
});
