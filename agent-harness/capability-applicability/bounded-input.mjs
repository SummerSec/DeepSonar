import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';

export const INPUT_LIMIT_BYTES = 1048576;
const nativeIo = { openSync, fstatSync, readSync, closeSync };

/** Opening a FIFO must not wait for a writer. Only a checked regular file is read. */
export function readBoundedInput(path, io = nativeIo) {
  let fd;
  try {
    fd = io.openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > INPUT_LIMIT_BYTES)
      throw new Error('INPUT_UNREADABLE');
    // One extra byte detects growth after fstat without an unbounded read/allocation.
    const buffer = Buffer.alloc(INPUT_LIMIT_BYTES + 1);
    let used = 0;
    while (used <= INPUT_LIMIT_BYTES) {
      const count = io.readSync(fd, buffer, used, buffer.length - used, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - used)
        throw new Error('INPUT_UNREADABLE');
      if (count === 0) return buffer.subarray(0, used);
      used += count;
    }
    throw new Error('INPUT_UNREADABLE');
  } catch {
    throw new Error('INPUT_UNREADABLE');
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch { throw new Error('INPUT_UNREADABLE'); }
    }
  }
}
