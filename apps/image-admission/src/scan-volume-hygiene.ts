import { lstat, readdir, unlink } from "node:fs/promises";

/** 扫描卷在 worker 内的挂载点，与 `archivePath` 使用同一目录（compose 把卷挂到 /scan）。 */
export const SCAN_VOLUME_MOUNT = "/scan";
/** `docker export -o <path>` 在成功 rename 前写入的同目录临时文件前缀。 */
export const SCAN_TEMP_PREFIX = ".tmp-";
/** 正式归档名形状：`<scanId>.tar`，scanId 是 uuid 文本。 */
const SCAN_ARCHIVE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar$/u;

/** 默认陈旧阈值：两倍单次扫描预算（clamscan 30 分钟），保证不碰正在写入的文件。 */
export const DEFAULT_SCAN_SWEEP_STALE_MS = 2 * 30 * 60_000;

export interface ScanVolumeSweepResult {
  removed: number;
  bytes: number;
  skipped: number;
  failed: number;
}

/** 只有两类名字会被清扫：CLI 的临时导出文件与 uuid 形状的正式归档；其它文件一律不碰。 */
export function isScanSweepCandidate(name: string): boolean {
  return name.startsWith(SCAN_TEMP_PREFIX) || SCAN_ARCHIVE_NAME.test(name);
}

export interface ScanVolumeSweepIo {
  readdir: (path: string) => Promise<string[]>;
  lstat: (path: string) => Promise<{ isFile: () => boolean; mtimeMs: number; size: number }>;
  unlink: (path: string) => Promise<void>;
}

export interface ScanVolumeSweepOptions {
  staleMs?: number;
  now?: number;
  /** 供测试注入；生产使用 node:fs/promises 的默认实现。 */
  io?: ScanVolumeSweepIo;
}

const defaultIo: ScanVolumeSweepIo = {
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path),
  unlink: (path) => unlink(path),
};

/** 清扫扫描卷里的死数据：`.tmp-*`（进程在 export 期间被杀）与陈旧 `<scanId>.tar`
 * （worker 在 export 完成后、finally 前死亡）。按 mtime 判定陈旧，避免删掉并发写入中的文件；
 * 卷不存在、条目在判定与删除之间消失都按安全路径处理，不抛给调用方。 */
export async function sweepScanVolume(
  root: string = SCAN_VOLUME_MOUNT,
  options: ScanVolumeSweepOptions = {},
): Promise<ScanVolumeSweepResult> {
  const staleMs = options.staleMs ?? DEFAULT_SCAN_SWEEP_STALE_MS;
  const now = options.now ?? Date.now();
  const io = options.io ?? defaultIo;
  const result: ScanVolumeSweepResult = { removed: 0, bytes: 0, skipped: 0, failed: 0 };
  let names: string[];
  try {
    names = await io.readdir(root);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!isScanSweepCandidate(name)) { result.skipped += 1; continue; }
    const path = `${root}/${name}`;
    try {
      const info = await io.lstat(path);
      if (!info.isFile()) { result.skipped += 1; continue; }
      if (now - info.mtimeMs < staleMs) { result.skipped += 1; continue; }
      await io.unlink(path);
      result.removed += 1;
      result.bytes += info.size;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
