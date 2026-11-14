// Isolated synthetic execd: its Ping deadline must not share the consumer thread.
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const load = createRequire(workerData.schedulerPackage);
const app = load('fastify')({ logger: false });
const nonce = Buffer.from('pty-consumer-heartbeat');
const count = 24;
const deadlineMs = 4000;
const progressConsumed = new Int32Array(workerData.progressConsumed);
let socket;
let deadline;
let pingAt;
let pong = false;
let consumed = false;
let finished = false;
let prompts = 0;
const stdout = records => socket.send(Buffer.concat([
  Buffer.from([1]), Buffer.from(records.map(record => JSON.stringify(record) + '\n').join('')),
]));
function finish() {
  if (!pong || !consumed || finished) return;
  finished = true;
  stdout([
    { type: 'tool_execution_end', toolCallId: 'load-tool', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'complete' }] } },
    { type: 'agent_end', willRetry: false },
    { type: 'agent_settled', aborted: false },
  ]);
  socket.send(JSON.stringify({ type: 'exit', exit_code: 0 }));
}
parentPort.on('message', message => {
  if (message === 'consuming' && pingAt === undefined) {
    pingAt = performance.now();
    socket.ping(nonce);
    deadline = setTimeout(() => {
      parentPort.postMessage({ type: 'heartbeat_timeout', prompts });
      socket.close(1011, 'keepalive ping timeout');
    }, deadlineMs);
  } else if (message === 'consumed') { consumed = true; finish(); }
});
(async () => {
  await app.register(load('@fastify/websocket'));
  app.post('/pty', async () => ({ session_id: 'heartbeat-pty' }));
  app.delete('/pty/:id', async () => ({ ok: true }));
  app.get('/pty/:id/ws', { websocket: true }, ws => {
    socket = ws;
    ws.on('error', () => {});
    ws.on('pong', payload => {
      if (pingAt === undefined || !payload.equals(nonce) || pong) return;
      const elapsed = performance.now() - pingAt;
      if (elapsed >= deadlineMs) return;
      clearTimeout(deadline);
      pong = true;
      parentPort.postMessage({ type: 'pong', elapsed, prompts, progressConsumed: Atomics.load(progressConsumed, 0) });
      finish();
    });
    ws.on('close', () => { clearTimeout(deadline); });
    ws.on('message', data => {
      if (data[0] !== 0) return;
      for (const line of data.subarray(1).toString().split('\n').filter(Boolean)) {
        let command;
        try {
          command = JSON.parse(line);
        } catch {
          continue; // 客户端只受自造合法帧；坏行直接跳过，不让 worker 因单行解析崩溃。
        }
        if (command.type === 'get_state') {
          stdout([{ type: 'response', id: command.id, command: 'get_state', success: true,
            data: { sessionId: 'heartbeat-session', sessionFile: '/workspace/.deepsonar-home/.pi/agent/heartbeat.jsonl',
              isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 0, autoCompactionEnabled: true } }]);
        } else if (command.type === 'prompt') {
          prompts++;
          // One WS message contains many RPC records: outer chunk fairness alone is insufficient.
          stdout([
            { type: 'response', id: command.id, command: 'prompt', success: true, data: { disposition: 'started' } },
            { type: 'agent_start' },
            { type: 'tool_execution_start', toolCallId: 'load-tool', toolName: 'bash', args: { command: 'synthetic fixture' } },
            ...Array.from({ length: count }, (_, sequence) => ({ type: 'tool_execution_update', toolCallId: 'load-tool', toolName: 'bash',
              partialResult: { content: [{ type: 'text', text: workerData.progress }], details: { sequence } } })),
          ]);
        } else throw new Error('Unexpected synthetic RPC command');
      }
    });
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  parentPort.postMessage({ type: 'ready', url, count, deadlineMs });
})().catch(error => parentPort.postMessage({ type: 'fixture_error', message: error.message }));
