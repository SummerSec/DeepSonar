import { shellQuote } from "./runtime-host.js";

export const MODEL_REQUEST_POLICY_BASE_URL = "http://127.0.0.1:38127/gateway";
export const MODEL_REQUEST_POLICY_PATH = "/workspace/.deepsonar/model-request-policy.mjs";

/** Explicit client admission policy; formed HTTP requests are never rewritten. */
export function modelRequestPolicyCommand(command: string, env: Record<string, string>, cli?: "claude-code"): string {
  if (!env.DEEPSONAR_REQUEST_POLICY_UPSTREAM) return command;
  if (!env.DEEPSONAR_GATEWAY_TOKEN) throw new Error("MODEL_REQUEST_POLICY_TOKEN_MISSING");
  return `node ${shellQuote(MODEL_REQUEST_POLICY_PATH)}${cli ? " --claude-launch-budget" : ""} -- ${shellQuote(command)}`;
}

/** Uploaded as a standalone Node module; no SDK, package install or image rebuild is required. */
export const MODEL_REQUEST_POLICY_SOURCE = String.raw`
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 16 * 1024 * 1024;
const AUTH = new Set(['authorization','x-api-key','anthropic-api-key','proxy-authorization']);
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function fail(code, status = 409) { throw Object.assign(new Error(code), { status }); }
function headers(raw, request = false) {
  const removed = new Set(HOP);
  if (request) { removed.add('host'); for (const name of AUTH) removed.add(name); }
  for (let i = 0; i < raw.length; i += 2) {
    http.validateHeaderName(raw[i]); http.validateHeaderValue(raw[i], raw[i + 1]);
    if (raw[i].toLowerCase() === 'connection') for (const name of raw[i + 1].split(',')) removed.add(name.trim().toLowerCase());
  }
  const result = [];
  for (let i = 0; i < raw.length; i += 2) if (!removed.has(raw[i].toLowerCase())) result.push(raw[i], raw[i + 1]);
  return result;
}
async function collect(stream, limit = LIMIT) {
  const chunks = []; let count = 0;
  for await (const chunk of stream) { count += chunk.length; if (count > limit) fail('MODEL_REQUEST_POLICY_BODY_LIMIT', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function exchange(base, path, method, rawHeaders, body, signal, rawTrailers = []) {
  const output = [];
  const trailers = headers(rawTrailers, true);
  for (let i = 0; i < trailers.length; i += 2) {
    if (['content-length','content-type','content-encoding','content-range'].includes(trailers[i].toLowerCase())) fail('MODEL_REQUEST_POLICY_TRAILER', 400);
  }
  for (let i = 0; i < rawHeaders.length; i += 2) if (!['content-length','host','trailer','transfer-encoding'].includes(rawHeaders[i].toLowerCase())) output.push(rawHeaders[i], rawHeaders[i + 1]);
  output.push('host', base.host);
  if (trailers.length) output.push('transfer-encoding','chunked','trailer',trailers.filter((_,i) => i % 2 === 0).join(', '));
  else if (body !== null) output.push('content-length',String(body.length));
  return new Promise((resolve, reject) => {
    const req = (base.protocol === 'https:' ? https : http).request({ protocol: base.protocol,
      hostname: base.hostname.replace(/^\[|\]$/g,''), port: base.port || undefined, method,
      path, headers: output, signal, agent: false, insecureHTTPParser: false }, resolve);
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => { socket.destroy(); req.destroy(); reject(new Error('MODEL_REQUEST_POLICY_UPGRADE')); });
    if (trailers.length) {
      if (body) req.write(body);
      req.addTrailers(Array.from({length: trailers.length / 2}, (_,i) => [trailers[i*2],trailers[i*2+1]])); req.end();
    } else req.end(body ?? undefined);
  });
}

export function prepareModelRequest(body, route, allowance) {
  if (!allowance || typeof allowance.policy_required !== 'boolean' || (allowance.remaining_tokens !== null
    && (!Number.isSafeInteger(allowance.remaining_tokens) || allowance.remaining_tokens < 0))) fail('MODEL_REQUEST_POLICY_ALLOWANCE_INVALID');
  if (!allowance.policy_required) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) fail('MODEL_REQUEST_POLICY_JSON_REQUIRED');
  const normalized = route.replace(/^\/?(?:v1\/)?/, '');
  const field = normalized === 'messages' || normalized === 'completions' ? 'max_tokens'
    : normalized === 'chat/completions' ? ('max_tokens' in body ? 'max_tokens' : 'max_completion_tokens')
      : normalized === 'responses' ? 'max_output_tokens' : null;
  if (!field || (body.n !== undefined && body.n !== 1) || (body.best_of !== undefined && body.best_of !== 1)
    || (normalized === 'completions' && typeof body.prompt !== 'string')) fail('MODEL_REQUEST_POLICY_PROTOCOL_UNSUPPORTED');
  const remaining = allowance.remaining_tokens;
  if (remaining === 0) fail('MODEL_REQUEST_POLICY_EXHAUSTED', 429);
  const output = { ...body };
  for (const name of [field, ...(normalized === 'chat/completions' ? ['max_tokens','max_completion_tokens'] : [])]) {
    if (body[name] !== undefined && (!Number.isSafeInteger(body[name]) || body[name] <= 0)) fail('MODEL_REQUEST_POLICY_OUTPUT_LIMIT');
  }
  if (remaining !== null) output[field] = Math.min(body[field] ?? remaining, remaining);
  if (normalized === 'chat/completions') {
    if (body.stream_options !== undefined && (!body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options))) fail('MODEL_REQUEST_POLICY_PROTOCOL_UNSUPPORTED');
    if (field === 'max_tokens') {
      if (body.max_completion_tokens !== undefined) output.max_tokens = Math.min(body.max_tokens, body.max_completion_tokens, remaining ?? Infinity);
      delete output.max_completion_tokens;
    }
    if (body.stream === true) output.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  }
  return output;
}

// Check ambiguous admission members without changing any formed request.
function assertPolicyMembers(source, owned = ['model','max_tokens','max_completion_tokens','max_output_tokens','n','best_of','stream','stream_options']) {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++; };
  const stringEnd = () => {
    cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') return;
    }
  };
  const valueEnd = () => {
    if (source[cursor] === '"') { stringEnd(); return; }
    if (source[cursor] === '{' || source[cursor] === '[') {
      const end = source[cursor++] === '{' ? '}' : ']';
      while (cursor < source.length && source[cursor] !== end) {
        if (source[cursor] === '"') stringEnd();
        else if (source[cursor] === '{' || source[cursor] === '[') valueEnd();
        else cursor++;
      }
      cursor++; return;
    }
    while (cursor < source.length && !/[,}\]\s]/.test(source[cursor])) cursor++;
  };
  whitespace(); cursor++;
  const members = [];
  whitespace();
  while (source[cursor] !== '}') {
    const start = cursor;
    stringEnd();
    const key = JSON.parse(source.slice(start, cursor));
    whitespace(); cursor++; whitespace();
    const valueStart = cursor; valueEnd(); const valueStop = cursor;
    whitespace();
    const comma = source[cursor] === ',' ? cursor++ : null;
    members.push({ key, start, valueStart, valueStop, comma });
    whitespace();
  }
  for (const key of owned) if (members.filter(member => member.key === key).length > 1) fail('MODEL_REQUEST_POLICY_DUPLICATE_MEMBER');
  if (owned.includes('stream_options')) {
    const options = members.find(member => member.key === 'stream_options');
    if (options && source[options.valueStart] === '{') assertPolicyMembers(source.slice(options.valueStart,options.valueStop), ['include_usage']);
  }
}

export function prepareModelRequestBytes(bytes, route, allowance) {
  const source = bytes.toString('utf8');
  const body = JSON.parse(source);
  const required = prepareModelRequest(body, route, allowance);
  if (allowance.policy_required) {
    assertPolicyMembers(source);
    if (JSON.stringify(body) !== JSON.stringify(required)) fail('MODEL_REQUEST_POLICY_PREGENERATION_REQUIRED');
  }
  return bytes;
}

export async function startModelRequestPolicy({ upstream, token, port = 38127 }) {
  const base = new URL(upstream);
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !token) fail('MODEL_REQUEST_POLICY_CONFIGURATION');
  const prefix = base.pathname.replace(/\/+$/, '');
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController(); controllers.add(controller);
    const signal = controller.signal;
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected);
    try {
      const presented = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (AUTH.has(name)) presented.push(name === 'authorization' ? req.rawHeaders[i + 1].replace(/^Bearer\s+/i,'') : req.rawHeaders[i + 1]);
      }
      if (!presented.length || presented.some(value => value !== token)) fail('MODEL_REQUEST_POLICY_AUTH', 401);
      if (!req.url.startsWith('/gateway/') || /[\x00-\x20\x7f#\\]/.test(req.url)) fail('MODEL_REQUEST_POLICY_TARGET', 400);
      const relative = req.url.slice('/gateway'.length);
      if (relative.startsWith('//')) fail('MODEL_REQUEST_POLICY_TARGET', 400);
      const route = relative.split('?')[0];
      let bytes = await collect(req);
      const modelRequest = req.method === 'POST' && /^\/(?:v1\/)?(?:messages|chat\/completions|responses|completions)$/.test(route);
      if (modelRequest) {
        const allowanceSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        let allowanceResponse, allowanceBytes;
        for (;;) {
          try {
            const current = await exchange(base, prefix + '/_allowance', 'GET', ['authorization','Bearer ' + token], null, allowanceSignal);
            const currentBytes = await collect(current, 65536);
            allowanceResponse = current; allowanceBytes = currentBytes;
          } catch (error) {
            if (allowanceSignal.aborted && !signal.aborted && allowanceBytes && allowanceResponse?.statusCode === 409) break;
            throw error;
          }
          let code;
          try { code = JSON.parse(allowanceBytes.toString('utf8')).error?.type; } catch { /* Forward malformed refusals without guessing. */ }
          if (allowanceResponse.statusCode !== 409 || !['JOB_TOKEN_USAGE_PENDING','REPAIR_USAGE_PENDING'].includes(code)) break;
          // The preceding response can arrive before its ledger commit. Poll only
          // this read-only projection; never replay a model request or an unknown effect.
          try { await delay(100, undefined, { signal: allowanceSignal }); }
          catch (error) { if (signal.aborted) throw error; break; }
        }
        if (allowanceResponse.statusCode !== 200) {
          res.writeHead(allowanceResponse.statusCode ?? 502, headers(allowanceResponse.rawHeaders)); res.end(allowanceBytes); return;
        }
        const allowance = JSON.parse(allowanceBytes.toString('utf8'));
        if (typeof allowance.policy_required !== 'boolean' || (allowance.remaining_tokens !== null
          && (!Number.isSafeInteger(allowance.remaining_tokens) || allowance.remaining_tokens < 0))) fail('MODEL_REQUEST_POLICY_ALLOWANCE_INVALID');
        if (allowance.policy_required) {
          if (!/(?:^application\/json|\+json)(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))
            || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) fail('MODEL_REQUEST_POLICY_JSON_REQUIRED');
          prepareModelRequestBytes(bytes, route, allowance);
        }
      }
      const outgoing = headers(req.rawHeaders, true); outgoing.push('authorization','Bearer ' + token);
      const connection = req.rawHeaders.flatMap((name,i,raw) => i % 2 === 0 && name.toLowerCase() === 'connection' ? [name,raw[i+1]] : []);
      const response = await exchange(base, prefix + relative, req.method, outgoing, bytes, signal, headers([...connection,...req.rawTrailers],true));
      res.writeHead(response.statusCode ?? 502, response.statusMessage, headers(response.rawHeaders)); res.flushHeaders();
      for await (const chunk of response) if (!res.write(chunk)) await once(res,'drain',{signal});
      const responseConnection = response.rawHeaders.flatMap((name,i,raw) => i % 2 === 0 && name.toLowerCase() === 'connection' ? [name,raw[i+1]] : []);
      const trailers = headers([...responseConnection,...response.rawTrailers]);
      if (trailers.length) res.addTrailers(Array.from({length: trailers.length/2},(_,i) => [trailers[i*2],trailers[i*2+1]]));
      res.end();
    } catch (error) {
      controller.abort();
      if (res.headersSent || res.destroyed) res.destroy();
      else {
        const code = /^MODEL_REQUEST_POLICY_/.test(error.message) ? error.message : 'MODEL_REQUEST_POLICY_FAILED';
        const hint = code === 'MODEL_REQUEST_POLICY_PREGENERATION_REQUIRED'
          ? 'Request output or usage options do not satisfy the current budget. Configure supported CLI options before generating a new request; the formed request was not rewritten or sent.'
          : code === 'MODEL_REQUEST_POLICY_EXHAUSTED'
            ? 'The current token budget is exhausted. This request was not sent; operator action must preserve cumulative usage.' : undefined;
        // Deterministic local budget rejection is not a transient provider
        // conflict/quota response. Claude's SDK and outer loop retry 409/429;
        // both honor x-should-retry:false and render error.message, not hint.
        const terminalBudget = hint !== undefined;
        res.writeHead(terminalBudget ? 400 : Number.isInteger(error.status) ? error.status : 502,
          {'content-type':'application/json', ...(terminalBudget ? {'x-should-retry':'false'} : {})});
        res.end(JSON.stringify({error:{type:terminalBudget ? 'invalid_request_error' : 'request_admission_policy',
          code, message:hint ? code + ': ' + hint : code, ...(hint ? {hint} : {})}}));
      }
    } finally { controllers.delete(controller); res.off('close',disconnected); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  return { server, close: async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

export async function prepareClaudeLaunch(command, environment, settings = []) {
  const base = new URL(environment.DEEPSONAR_REQUEST_POLICY_UPSTREAM);
  const response = await exchange(base, base.pathname.replace(/\/+$/, '') + '/_allowance', 'GET',
    ['authorization','Bearer ' + environment.DEEPSONAR_GATEWAY_TOKEN], null, AbortSignal.timeout(15_000));
  const bytes = await collect(response, 65536);
  if (response.statusCode !== 200) fail('MODEL_REQUEST_POLICY_ALLOWANCE_UNAVAILABLE');
  const allowance = JSON.parse(bytes.toString('utf8'));
  if (typeof allowance.policy_required !== 'boolean' || (allowance.remaining_tokens !== null
    && (!Number.isSafeInteger(allowance.remaining_tokens) || allowance.remaining_tokens < 0))) fail('MODEL_REQUEST_POLICY_ALLOWANCE_INVALID');
  if (allowance.remaining_tokens === null) return { command, env: environment };
  if (allowance.remaining_tokens === 0) fail('MODEL_REQUEST_POLICY_EXHAUSTED', 429);
  let cap = allowance.remaining_tokens;
  for (const value of [environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS, ...settings.map(setting => setting?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS)]) {
    if (value !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) fail('MODEL_REQUEST_POLICY_CLAUDE_CAP_INVALID');
      cap = Math.min(cap, parsed);
    }
  }
  const configuration = JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cap) } });
  // Only generated numeric settings are appended, never user-controlled shell text.
  return { command: command + " --settings '" + configuration + "'",
    env: { ...environment, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cap) } };
}

async function launch() {
  const delimiter = process.argv.indexOf('--');
  if (delimiter < 0 || !process.argv[delimiter + 1]) fail('MODEL_REQUEST_POLICY_COMMAND');
  const policy = await startModelRequestPolicy({ upstream: process.env.DEEPSONAR_REQUEST_POLICY_UPSTREAM, token: process.env.DEEPSONAR_GATEWAY_TOKEN });
  let launchCommand = process.argv.slice(delimiter+1).join(' '), launchEnv = process.env;
  if (process.argv.slice(2,delimiter).includes('--claude-launch-budget')) {
    try {
      const settings = [];
      for (const file of new Set([path.join(process.env.HOME ?? '/workspace/.deepsonar-home','.claude/settings.json'),
        path.join(process.cwd(),'.claude/settings.json'), path.join(process.cwd(),'.claude/settings.local.json')])) {
        try { settings.push(JSON.parse(await readFile(file,'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const prepared = await prepareClaudeLaunch(launchCommand, launchEnv, settings);
      launchCommand = prepared.command; launchEnv = prepared.env;
    } catch (error) { await policy.close(); throw error; }
  }
  let child;
  try { child = spawn('/bin/sh',['-c',launchCommand], { stdio:'inherit', detached:true, env:launchEnv }); }
  catch (error) { await policy.close(); throw error; }
  let closing = false;
  const killGroup = signal => { if (child.pid) { try { process.kill(-child.pid,signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  const finish = async (code, signal) => {
    if (closing) return; closing = true;
    killGroup(signal ?? 'SIGTERM');
    const force = setTimeout(() => { killGroup('SIGKILL'); process.exit(code); }, 2000);
    await policy.close();
    if (child.exitCode === null && child.signalCode === null) await once(child,'exit').catch(() => {});
    killGroup('SIGKILL'); clearTimeout(force); process.exit(code);
  };
  process.once('SIGTERM',() => { void finish(143,'SIGTERM'); });
  process.once('SIGINT',() => { void finish(130,'SIGINT'); });
  child.once('error',() => { void finish(127); });
  child.once('exit',(code,signal) => { void finish(code ?? (signal === 'SIGINT' ? 130 : 143)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launch().catch(() => { process.stderr.write('MODEL_REQUEST_POLICY_START_FAILED\n'); process.exitCode = 78; });
}
`;
