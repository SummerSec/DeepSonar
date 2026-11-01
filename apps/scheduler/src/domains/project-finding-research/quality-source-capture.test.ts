import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const captureUrl = new URL("./quality-source-capture.ts", import.meta.url).href;
const transformed = 'globalThis.qualityEvaluations = (globalThis.qualityEvaluations ?? 0) + 1; export const observed = "transformed-loader-source";';

function child(body: string, useTsx = false): void {
  const prelude = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import module, { registerHooks, syncBuiltinESMExports } from 'node:module';
    const captureUrl = ${JSON.stringify(captureUrl)};
    const origin = new URL('./identity.ts', captureUrl).href;
    const transformed = ${JSON.stringify(transformed)};
    const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
    const fixture = (url, source, format = 'module') => registerHooks({
      resolve(specifier, context, next) {
        return specifier === url ? {url, shortCircuit: true} : next(specifier, context);
      },
      load(target, context, next) {
        return target === url ? {format, source, shortCircuit: true} : next(target, context);
      },
    });
  `;
  const loader = useTsx
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
    : [];
  const result = spawnSync(process.execPath, [...loader, "--input-type=module", "--eval", prelude + body], {
    encoding: "utf8", timeout: 15_000,
    // The optional real TSX test must not create an on-disk transform cache.
    env: { ...process.env, TSX_DISABLE_CACHE: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("real Node load hook captures transformed evaluator bytes, not disk, with immutable stable receipts", () => {
  child(`
    const evaluatedSource = transformed + '; globalThis.capturedDuringEvaluation = globalThis.captureAtEvaluation();';
    const original = Buffer.from(evaluatedSource);
    fixture(origin, original);
    const capture = await import(captureUrl);
    capture.installFindingQualitySourceCapture();
    globalThis.captureAtEvaluation = () => capture.requireCapturedFindingQualitySource(origin).source_digest;
    const evaluated = await import(origin);
    assert.equal(evaluated.observed, 'transformed-loader-source');
    assert.equal(globalThis.qualityEvaluations, 1);
    assert.equal(globalThis.capturedDuringEvaluation, digest(evaluatedSource));
    const receipt = capture.requireCapturedFindingQualitySource(origin);
    assert.equal(receipt.source_digest, digest(evaluatedSource));
    assert.notEqual(receipt.source_digest, digest(readFileSync(new URL(origin))));
    assert.equal(receipt.source_byte_length, Buffer.byteLength(evaluatedSource));
    assert.equal(receipt.source_format, 'module');
    assert.equal(receipt.integrity_basis, 'node_sync_load_returned_source_under_trusted_preload');
    assert.ok(Object.isFrozen(receipt));
    assert.throws(() => { receipt.source_digest = digest('caller replacement'); }, TypeError);
    original.fill(0);
    assert.strictEqual(capture.requireCapturedFindingQualitySource(new URL(origin)), receipt);
    await import(origin);
    assert.equal(globalThis.qualityEvaluations, 1);
    assert.equal(receipt.source_digest, digest(evaluatedSource));
  `);
});

for (const representation of ["string", "buffer", "view", "arraybuffer", "native-typescript"] as const) {
  test(`real Node hook captures ${representation} load results before evaluation`, () => {
    child(`
      const text = ${representation === "native-typescript"
        ? JSON.stringify('export const observed: string = "transformed-loader-source";') : "transformed"};
      const padded = Buffer.concat([Buffer.from('padding'), Buffer.from(text), Buffer.from('trailer')]);
      const source = ${representation === "string" ? "text"
        : representation === "arraybuffer" ? "Uint8Array.from(Buffer.from(text)).buffer"
          : representation === "view" ? "new Uint8Array(padded.buffer, padded.byteOffset + 7, Buffer.byteLength(text))"
            : "Buffer.from(text)"};
      fixture(origin, source, ${JSON.stringify(representation === "native-typescript" ? "module-typescript" : "module")});
      const capture = await import(captureUrl);
      capture.installFindingQualitySourceCapture();
      assert.equal((await import(origin)).observed, 'transformed-loader-source');
      assert.equal(capture.requireCapturedFindingQualitySource(origin).source_digest, digest(text));
    `);
  });
}

test("fixed production JS host URL is captured without importing a real governed graph", () => {
  child(`
    const host = new URL('./quality-state-store.js', captureUrl).href;
    fixture(host, transformed);
    const capture = await import(captureUrl);
    capture.installFindingQualitySourceCapture();
    await import(host);
    assert.equal(capture.requireCapturedFindingQualitySource(host).source_digest, digest(transformed));
  `);
});

test("missing, foreign, query, fragment and uninstalled sources fail closed with no fallback", () => {
  child(`
    const capture = await import(captureUrl);
    assert.throws(() => capture.requireCapturedFindingQualitySource(origin), /NOT_INSTALLED/);
    assert.throws(() => capture.installFindingQualitySourceCapture({ reset: true }), /INSTALL_ARGUMENTS_INVALID/);
    capture.installFindingQualitySourceCapture();
    for (const bad of ['not-a-url', origin + '?revision=caller', origin + '#caller',
      new URL('../identity.ts', captureUrl).href, new URL('./model.ts', captureUrl).href]) {
      assert.throws(() => capture.requireCapturedFindingQualitySource(bad), /ORIGIN_INVALID/);
    }
    assert.throws(() => capture.requireCapturedFindingQualitySource(origin), /UNOBSERVED/);
    assert.throws(() => capture.requireCapturedFindingQualitySource(captureUrl), /UNOBSERVED/);
    assert.deepEqual(Object.keys(capture).sort(),
      ['installFindingQualitySourceCapture', 'requireCapturedFindingQualitySource']);
    assert.throws(() => capture.installFindingQualitySourceCapture(), /ALREADY_INSTALLED/);
  `);
});

test("queried governed module alias is rejected by the real hook before evaluation", () => {
  child(`
    fixture(origin, transformed);
    const capture = await import(captureUrl);
    capture.installFindingQualitySourceCapture();
    await assert.rejects(import(origin + '?caller-replay=1'), /ORIGIN_INVALID/);
    assert.equal(globalThis.qualityEvaluations, undefined);
    assert.throws(() => capture.requireCapturedFindingQualitySource(origin), /ORIGIN_INVALID/);
  `);
});

test("late installation cannot recapture cached evaluations or self-certify its preload", () => {
  child(`
    fixture(origin, transformed);
    await import(origin);
    const capture = await import(captureUrl);
    capture.installFindingQualitySourceCapture();
    await import(origin);
    assert.equal(globalThis.qualityEvaluations, 1);
    assert.throws(() => capture.requireCapturedFindingQualitySource(origin), /UNOBSERVED/);
    assert.throws(() => capture.requireCapturedFindingQualitySource(captureUrl), /UNOBSERVED/);
  `);
});

for (const [source, format, error] of [
  ["transformed", "commonjs", "FORMAT_UNSUPPORTED"],
  ["undefined", "module", "LOAD_FAILED"],
  ["new Uint8Array(new SharedArrayBuffer(64))", "module", "SOURCE_UNAVAILABLE"],
  ["''", "module", "SIZE_INVALID"],
  ["'x'.repeat(1024 * 1024 + 1)", "module", "SIZE_INVALID"],
] as const) {
  test(`real governed load rejects ${error} before evaluation and keeps failure closed`, () => {
    child(`
      fixture(origin, ${source}, ${JSON.stringify(format)});
      const capture = await import(captureUrl);
      capture.installFindingQualitySourceCapture();
      await assert.rejects(import(origin), /${error}/);
      assert.equal(globalThis.qualityEvaluations, undefined);
      assert.throws(() => capture.requireCapturedFindingQualitySource(origin), /${error}/);
    `);
  });
}

test("private hook detects capture mismatches, retains immutable receipts, and has no reset", () => {
  child(`
    const actualRegister = registerHooks;
    let hook;
    module.registerHooks = options => { hook = options.load; return actualRegister(options); };
    syncBuiltinESMExports();
    const capture = await import(captureUrl);
    capture.installFindingQualitySourceCapture();
    module.registerHooks = actualRegister;
    syncBuiltinESMExports();
    const context = {format: 'module', conditions: [], importAttributes: {}};
    const next = () => ({format: 'module', source: transformed});
    hook(origin, context, next);
    const first = capture.requireCapturedFindingQualitySource(origin);
    hook(origin, context, next);
    assert.strictEqual(capture.requireCapturedFindingQualitySource(origin), first);
    assert.throws(() => hook(origin, context,
      () => ({format: 'module', source: transformed + '\\n// different bytes'})), /CONFLICT/);
    assert.throws(() => capture.requireCapturedFindingQualitySource(origin), /CONFLICT/);
    assert.throws(() => capture.installFindingQualitySourceCapture(), /ALREADY_INSTALLED/);
    assert.equal(first.source_digest, digest(transformed));
  `);
});

test("real TSX ordering captures transformed parameter-property module source under the trusted preload", () => {
  child(`
    const capture = await import(captureUrl);
    capture.installFindingQualitySourceCapture();
    const contractUrl = new URL('./quality-contract.ts', captureUrl).href;
    const contract = await import(contractUrl);
    assert.equal(new contract.QualityContractError('checked').code, 'checked');
    const receipt = capture.requireCapturedFindingQualitySource(contract.QUALITY_CONTRACT_MODULE_URL);
    assert.equal(receipt.source_format, 'module');
    assert.notEqual(receipt.source_digest, digest(readFileSync(new URL(contractUrl))));
    assert.equal(receipt.integrity_basis, 'node_sync_load_returned_source_under_trusted_preload');
  `, true);
});
