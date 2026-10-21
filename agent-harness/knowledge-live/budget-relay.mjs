/** Test-only transport limiter; never generates model responses or logs request bodies/headers. */
import http from 'node:http';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function openBudget(config) {
  for (const key of ['maxRequests', 'maxOutputTokens', 'maxInputBytes']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`invalid ${key}`);
  }
  if (!Number.isFinite(config.maxUsd) || !Number.isFinite(config.reserveUsdPerRequest)
    || !(config.maxUsd > 0) || !(config.reserveUsdPerRequest > 0)
    || config.providerHardLimitUsd !== config.maxUsd) throw new Error('provider hard spending limit acknowledgement required');
  const lock = `${config.journal}.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  let used = 0, stopped = false;
  const record = (event) => {
    const journal = openSync(config.journal, "a", 0o600);
    try { appendFileSync(journal, JSON.stringify(event) + "\n"); fsyncSync(journal); }
    finally { closeSync(journal); }
  };
  try {
    if (existsSync(config.journal)) {
      for (const line of readFileSync(config.journal, 'utf8').trim().split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'stop') { stopped = true; continue; }
        if (event.type !== 'reservation' || event.number !== used + 1
          || event.reserve_usd !== config.reserveUsdPerRequest) throw new Error('budget journal mismatch');
        used++;
      }
    }
  } catch (error) { closeSync(fd); unlinkSync(lock); throw error; }
  return {
    status: () => ({ used_requests: used, max_requests: config.maxRequests,
      reserved_usd: used * config.reserveUsdPerRequest, max_usd: config.maxUsd,
      exhausted: stopped || used >= config.maxRequests || (used + 1) * config.reserveUsdPerRequest > config.maxUsd }),
    reserve() {
      if (stopped || used >= config.maxRequests || (used + 1) * config.reserveUsdPerRequest > config.maxUsd)
        throw new Error('LIVE_BUDGET_EXHAUSTED');
      // Charge before transport. Errors, disconnects and restarts never refund uncertain effects.
      record({ type: 'reservation', number: used + 1,
        reserve_usd: config.reserveUsdPerRequest, at: new Date().toISOString() });
      used++;
    },
    stop() { record({ type: 'stop' }); stopped = true; },
    close() { closeSync(fd); unlinkSync(lock); },
  };
}

export function startBudgetRelay(config) {
  const upstream = new URL(config.upstream);
  if (upstream.username || upstream.password || upstream.search || upstream.hash
    || (upstream.protocol !== 'https:' && !(config.testOnly && upstream.hostname === '127.0.0.1')))
    throw new Error('HTTPS upstream without embedded credentials required');
  const budget = openBudget(config);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__budget') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(budget.status())); return;
    }
    if (req.method === 'POST' && req.url === '/__stop') { budget.stop(); res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || !['/v1/messages', '/v1/chat/completions', '/v1/responses'].includes(req.url)) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > config.maxInputBytes) throw new Error('LIVE_INPUT_LIMIT');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== config.model) throw new Error('LIVE_MODEL_MISMATCH');
      const field = req.url === '/v1/responses' ? 'max_output_tokens'
        : ('max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens');
      if (!Number.isSafeInteger(body[field]) || body[field] < 1 || body[field] > config.maxOutputTokens)
        throw new Error('LIVE_OUTPUT_LIMIT');
      budget.reserve();
      const headers = { 'content-type': 'application/json' };
      for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'])
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      const response = await fetch(new URL(req.url, upstream), { method: 'POST', headers,
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(180000) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      for await (const chunk of response.body ?? []) res.write(chunk);
      res.end();
    } catch (error) {
      const code = /^LIVE_[A-Z_]+$/.test(error.message) ? error.message : 'LIVE_TRANSPORT_FAILED';
      if (!res.headersSent) res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: code, message: code } }));
    }
  });
  server.on('close', () => budget.close());
  return server.listen(config.port, '127.0.0.1');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.KNOWLEDGE_LIVE_APPROVED !== 'yes') throw new Error('paid-run approval required');
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  startBudgetRelay(config);
  console.log('Budget relay listening on loopback; credentials and payloads are not logged.');
}
