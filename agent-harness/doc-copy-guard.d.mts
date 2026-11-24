export function findBannedCopy(input: {
  files: readonly string[];
  pattern: RegExp;
}): string[];
