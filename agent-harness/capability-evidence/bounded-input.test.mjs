import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, writeFileSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBoundedInput, INPUT_LIMIT_BYTES } from './bounded-input.mjs';
import { sourceDigest } from './report.mjs';

function fakeIo({ bytes = Buffer.from('{}'), size = bytes.length, chunk = bytes.length, errorAt, regular = true } = {}) {
  const state = { opens: 0, stats: 0, reads: 0, closes: 0, requested: 0, offset: 0, flags: null };
  const io = {
    openSync(_path, flags) { state.opens++; state.flags = flags; if (errorAt === 'open') throw new Error('secret path'); return 0; },
    fstatSync(fd) { assert.equal(fd, 0); state.stats++; if (errorAt === 'stat') throw new Error('secret path');
      return { size, isFile: () => regular }; },
    readSync(fd, output, offset, length, position) {
      assert.equal(fd, 0); assert.equal(position, null); state.reads++; state.requested += length;
      assert.ok(offset + length <= INPUT_LIMIT_BYTES + 1);
      if (errorAt === 'read') throw new Error('secret path');
      const n = Math.min(chunk, length, bytes.length - state.offset);
      bytes.copy(output, offset, state.offset, state.offset + n); state.offset += n; return n;
    },
    closeSync(fd) { assert.equal(fd, 0); state.closes++; if (errorAt === 'close') throw new Error('secret path'); },
  };
  return { io, state };
}

test('bounded reader opens nonblocking and handles short reads, including fd zero', () => {
  const { io, state } = fakeIo({ bytes: Buffer.from('abcdef'), chunk: 2 });
  assert.equal(readBoundedInput('ignored', io).toString(), 'abcdef');
  assert.ok(state.flags & constants.O_NONBLOCK); assert.equal(state.reads, 4); assert.equal(state.closes, 1);
});
test('regular empty and exact-limit files are accepted; growth reads at most limit plus one', () => {
  for (const size of [0, INPUT_LIMIT_BYTES]) {
    const { io, state } = fakeIo({ bytes: Buffer.alloc(size) });
    assert.equal(readBoundedInput('ignored', io).length, size); assert.equal(state.closes, 1);
  }
  const { io, state } = fakeIo({ bytes: Buffer.alloc(INPUT_LIMIT_BYTES + 20), size: 0, chunk: 16384 });
  assert.throws(() => readBoundedInput('ignored', io), /^Error: INPUT_UNREADABLE$/);
  assert.equal(state.offset, INPUT_LIMIT_BYTES + 1); assert.equal(state.closes, 1);
});
test('nonregular and oversized stat results fail before reading or allocating input contents', () => {
  for (const options of [{ regular: false }, { size: INPUT_LIMIT_BYTES + 1 }, { size: -1 }, { size: Infinity }]) {
    const { io, state } = fakeIo(options);
    assert.throws(() => readBoundedInput('ignored', io), /^Error: INPUT_UNREADABLE$/);
    assert.equal(state.reads, 0); assert.equal(state.closes, 1);
  }
});
test('open/stat/read/close failures stay sanitized and every acquired descriptor closes once', () => {
  for (const errorAt of ['open', 'stat', 'read', 'close']) {
    const { io, state } = fakeIo({ errorAt });
    assert.throws(() => readBoundedInput('/secret/input', io), /^Error: INPUT_UNREADABLE$/);
    assert.equal(state.closes, errorAt === 'open' ? 0 : 1);
  }
});
test('actual regular, sparse oversized and directory inputs use the bounded path safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-bounded-'));
  try {
    const path = join(dir, 'input'); writeFileSync(path, 'small'); assert.equal(readBoundedInput(path).toString(), 'small');
    const fd = openSync(path, 'w'); try { ftruncateSync(fd, INPUT_LIMIT_BYTES + 1); } finally { closeSync(fd); }
    assert.throws(() => readBoundedInput(path), /^Error: INPUT_UNREADABLE$/);
    assert.throws(() => readBoundedInput(dir), /^Error: INPUT_UNREADABLE$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI accepts a valid report and rejects unreadable inputs without disclosing paths or bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-cli-'));
  const cli = fileURLToPath(new URL('./report.mjs', import.meta.url));
  const invoke = (path, digest) => spawnSync(process.execPath, [cli, path, digest], { encoding: 'utf8', timeout: 5000 });
  try {
    const path = join(dir, 'input.json');
    const input = { schema: 'deepsonar.capability-evidence-export/v1', captured_at: '2026-10-29T00:00:00Z',
      project_id: '00000000-0000-4000-8000-000000000001', jobs: [], attempts: [], versions: [], usages: [], receipts: [] };
    writeFileSync(path, JSON.stringify(input));
    const valid = invoke(path, sourceDigest(input)); assert.equal(valid.status, 0);
    assert.equal(JSON.parse(valid.stdout).mode, 'offline_audit_not_recommendation'); assert.equal(valid.stderr, '');
    const oversized = join(dir, 'large'), malformed = join(dir, 'invalid.json');
    const fd = openSync(oversized, 'w');
    try { ftruncateSync(fd, INPUT_LIMIT_BYTES + 1); } finally { closeSync(fd); }
    writeFileSync(malformed, 'private-invalid-json');
    for (const bad of [dir, oversized, malformed, join(dir, 'private-missing')]) {
      const result = invoke(bad, '0'.repeat(64)); assert.equal(result.status, 1);
      assert.equal(result.stdout, ''); assert.equal(result.stderr, 'CAPABILITY_EVIDENCE_REPORT_REJECTED\n');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
