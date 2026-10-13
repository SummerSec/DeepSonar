#!/usr/bin/env node
/** Fail-closed checks shared by the image build, preflight and native smoke. */
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REA_NODE_ENGINES = '^22.19.0 || ^24.11.0 || >=26.0.0';
export function supportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return (major === 22 && minor >= 19) || (major === 24 && minor >= 11) || major >= 26;
}
export function verifyIntegrity(bytes, integrity) {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, 'expected pinned SHA-512 SRI');
  const wanted = Buffer.from(integrity.slice(7), 'base64');
  const actual = createHash('sha512').update(bytes).digest();
  assert(timingSafeEqual(actual, wanted), 'downloaded REA tarball integrity mismatch');
  return true;
}
export function verifyElfArchitecture(bytes, arch) {
  assert(['amd64', 'arm64'].includes(arch), 'unsupported architecture');
  assert(bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'native decompiler is not ELF');
  assert.equal(bytes[4], 2, 'native decompiler must be ELF64');
  assert.equal(bytes[5], 1, 'native decompiler must be little-endian');
  assert.equal(bytes.readUInt16LE(18), arch === 'amd64' ? 62 : 183, 'native decompiler ELF machine mismatch');
  return true;
}
export function nativeArch(value) {
  if (['x64', 'x86_64', 'amd64'].includes(value)) return 'amd64';
  if (['arm64', 'aarch64'].includes(value)) return 'arm64';
  throw new Error(`unsupported architecture: ${value}`);
}
function main(args) {
  if (args[0] === '--node-version' && args.length === 2) {
    assert(supportedNodeVersion(args[1]), `Node ${args[1]} does not satisfy ${REA_NODE_ENGINES}`);
  } else if (args[0] === '--integrity' && args.length === 3) {
    verifyIntegrity(readFileSync(args[1]), args[2]);
  } else if (args[0] === '--elf' && args.length === 3) {
    verifyElfArchitecture(readFileSync(args[1]), args[2]);
  } else {
    throw new Error('usage: reverse-toolchain-check.mjs --node-version VERSION | --integrity TARBALL SHA512_SRI | --elf FILE amd64|arm64');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
