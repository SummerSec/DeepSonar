import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {COSIGN_VERSION,sha256,platformSignatureTarget,platformSignatureAnnotations,PLATFORM_SERVICES} from './platform-upgrade-signature-contract.mjs';
const binary=process.env.DEEPSONAR_TEST_COSIGN;
const expected=process.env.DEEPSONAR_TEST_COSIGN_SHA256;
test('real pinned cosign signs ephemeral-key payload and rejects tampering/wrong key; not keyless Release acceptance', {skip:!binary,timeout:120000},()=>{
  assert.ok(isAbsolute(binary));assert.match(expected??'',/^[a-f0-9]{64}$/);assert.equal(sha256(readFileSync(binary)),expected);
  const dir=mkdtempSync(join(tmpdir(),'pr747-cosign-crypto-'));
  const run=(args)=>execFileSync(binary,args,{cwd:dir,env:{PATH:'/usr/bin:/bin',HOME:dir,COSIGN_PASSWORD:''},encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']});
  try {
    assert.equal(JSON.parse(run(['version','--json'])).gitVersion,COSIGN_VERSION);
    run(['generate-key-pair','--output-key-prefix',join(dir,'temporary')]);
    run(['generate-key-pair','--output-key-prefix',join(dir,'wrong')]);
    const target=platformSignatureTarget({version:'1.2.3',commit_sha:'a'.repeat(40),schema_version:61,
      images:Object.fromEntries(PLATFORM_SERVICES.map(s=>[s,`ghcr.io/summersec/deepsonar-${s}@sha256:${'a'.repeat(64)}`]))});
    const payload=join(dir,'payload.json'),bundle=join(dir,'bundle.json');
    const data=JSON.stringify({target,annotations:platformSignatureAnnotations(target,'scheduler')});
    writeFileSync(payload,data,{mode:0o600});
    // Only isolated local-key cryptographic tests omit tlog; production verifier has no bypass switch.
    run(['signing-config','create','--out',join(dir,'signing-config.json')]);
    run(['sign-blob','--yes','--key',join(dir,'temporary.key'),'--signing-config',join(dir,'signing-config.json'),'--bundle',bundle,payload]);
    const verify=['verify-blob','--key',join(dir,'temporary.pub'),'--bundle',bundle,'--insecure-ignore-tlog',payload];
    run(verify);
    assert.throws(()=>run(['verify-blob','--key',join(dir,'wrong.pub'),'--bundle',bundle,'--insecure-ignore-tlog',payload]));
    writeFileSync(payload,data.replace('1.2.3','1.2.4'));assert.throws(()=>run(verify));
    writeFileSync(payload,data);const broken=JSON.parse(readFileSync(bundle,'utf8'));
    // Alter actual signature bytes, preserving syntactically valid bundle structure.
    const sig=broken.messageSignature.signature;broken.messageSignature.signature=Buffer.alloc(Buffer.from(sig,'base64').length,1).toString('base64');
    writeFileSync(bundle,JSON.stringify(broken));assert.throws(()=>run(verify));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
