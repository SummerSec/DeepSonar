import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBudget } from './budget-relay.mjs';

test('reservations survive restart, reject concurrent owner and never exceed ceilings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-budget-'));
  const config = { journal: join(dir, 'ledger'), maxRequests: 3, maxOutputTokens: 32,
    maxInputBytes: 4096, maxUsd: 2, providerHardLimitUsd: 2, reserveUsdPerRequest: 1 };
  try {
    let budget = openBudget(config);
    assert.throws(() => openBudget(config));
    budget.reserve(); budget.close();
    budget = openBudget(config);
    assert.equal(budget.status().used_requests, 1);
    budget.reserve(); assert.throws(() => budget.reserve(), /EXHAUSTED/);
    assert.equal(budget.status().reserved_usd, 2); budget.close();
    assert.throws(() => openBudget({ ...config, providerHardLimitUsd: 0 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('request count is a separate hard bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-budget-'));
  const config = { journal: join(dir, 'ledger'), maxRequests: 1, maxOutputTokens: 32,
    maxInputBytes: 4096, maxUsd: 10, providerHardLimitUsd: 10, reserveUsdPerRequest: 1 };
  try { const budget = openBudget(config); budget.reserve(); assert.throws(() => budget.reserve(), /EXHAUSTED/); budget.close(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop remains fail closed after restarting the relay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-budget-'));
  const config = { journal: join(dir, 'ledger'), maxRequests: 10, maxOutputTokens: 32,
    maxInputBytes: 4096, maxUsd: 10, providerHardLimitUsd: 10, reserveUsdPerRequest: 1 };
  try { let budget = openBudget(config); budget.stop(); budget.close(); budget = openBudget(config);
    assert.throws(() => budget.reserve(), /EXHAUSTED/); budget.close(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('relay forwards real bytes once, blocks another request and rejects model/output drift', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { startBudgetRelay } = await import('./budget-relay.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-budget-http-'));
  let calls = 0;
  const upstream = createServer(async (req, res) => { for await (const chunk of req) void chunk;
    calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"transport-fixture"}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = startBudgetRelay({ upstream: `http://127.0.0.1:${upstream.address().port}`, testOnly: true, port: 0,
    model: 'fixture', journal: join(dir, 'ledger'), maxRequests: 1, maxOutputTokens: 32,
    maxInputBytes: 4096, maxUsd: 10, providerHardLimitUsd: 10, reserveUsdPerRequest: 1 });
  await once(relay, 'listening');
  const send = body => fetch(`http://127.0.0.1:${relay.address().port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await send({ model: 'wrong', max_tokens: 1 })).status, 429);
    assert.equal((await send({ model: 'fixture', max_tokens: 33 })).status, 429);
    assert.equal(calls, 0);
    assert.equal(await (await send({ model: 'fixture', max_tokens: 32 })).text(), '{"id":"transport-fixture"}');
    assert.equal((await send({ model: 'fixture', max_tokens: 1 })).status, 429);
    assert.equal(calls, 1);
  } finally { await new Promise(r => relay.close(r)); await new Promise(r => upstream.close(r));
    rmSync(dir, { recursive: true, force: true }); }
});
