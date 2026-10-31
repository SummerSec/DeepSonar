/** Retired Agent CLIs kept only for historical Job Session 只读渲染，不进入新 Job。 */
export const LEGACY_SESSION_CLIS = ["codex", "open-code"] as const;
export type LegacySessionCli = (typeof LEGACY_SESSION_CLIS)[number];

export function isLegacySessionCli(cli: string): cli is LegacySessionCli {
  return (LEGACY_SESSION_CLIS as readonly string[]).includes(cli);
}

export function normalizeLegacySessionCli(cli?: string | null): LegacySessionCli | undefined {
  if (!cli) return undefined;
  const value = cli.trim().toLowerCase();
  if (value === "codex") return "codex";
  if (value === "opencode" || value === "open-code" || value === "open_code") return "open-code";
  return undefined;
}

export function legacySessionCliLabel(cli: LegacySessionCli): string {
  return cli === "codex" ? "Codex" : "OpenCode";
}
