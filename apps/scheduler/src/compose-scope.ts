import { invalidControlPayload } from "./control-input.js";
import type { FrozenTaskSeedFinding } from "./task-compose.js";

export const COMPOSE_SCOPED_ROLES = new Set(["explore", "audit"]);

export const COMPOSE_SCOPE_RULE =
  "只围绕冻结种子做确认、补证与组合链；禁止浅克隆种子以外仓库，禁止提交无关新资产或同根因变体 Finding。explore/audit 必须绑定至少一条 imported 种子投影，prompt 只覆盖该种子资产。";

export interface ComposePromptScope {
  mode: "seed_assets_only";
  seed_count: number;
  locations: string[];
  rule: string;
}

export function composeAssetKeys(location: string | null | undefined): string[] {
  if (!location?.trim()) return [];
  const stripped = location.trim().replace(/:\d+\s*$/, "").replace(/\\/g, "/");
  const keys = new Set<string>();
  const addRepo = (host: string, org: string, repo: string) => {
    keys.add(`${host.toLowerCase()}/${org.toLowerCase()}/${repo.toLowerCase()}`);
  };

  try {
    if (/^https?:\/\//i.test(stripped)) {
      const url = new URL(stripped);
      const parts = url.pathname.split("/").filter(Boolean)
        .filter((part, index) => !(index >= 2 && ["blob", "tree", "src", "commit", "raw"].includes(part)));
      if (parts.length >= 2) addRepo(url.host, parts[0], parts[1]);
      return [...keys];
    }
  } catch {
    // Fall through to path matching when the location is not a URL.
  }

  const hostRepo = stripped.match(/^([a-z0-9.-]+\.[a-z]{2,})\/([a-z0-9._-]+)\/([a-z0-9._-]+)(?::|\/|$)/i);
  if (hostRepo) {
    addRepo(hostRepo[1], hostRepo[2], hostRepo[3]);
    return [...keys];
  }

  const orgRepo = stripped.match(/^([a-z0-9._-]+)\/([a-z0-9._-]+):(.+)$/i);
  if (orgRepo) {
    keys.add(`${orgRepo[1].toLowerCase()}/${orgRepo[2].toLowerCase()}`);
    return [...keys];
  }

  const path = stripped.replace(/^\/+/, "").split("/").filter(Boolean);
  if (path[0]) keys.add(path[0].toLowerCase());
  if (path.length >= 2) keys.add(`${path[0]}/${path[1]}`.toLowerCase());
  return [...keys];
}

export function composeFindingMatchesSeedAssets(
  location: string | null | undefined,
  seeds: readonly Pick<FrozenTaskSeedFinding, "location">[],
): boolean {
  const findingKeys = composeAssetKeys(location);
  if (findingKeys.length === 0) return false;
  const seedKeys = new Set(seeds.flatMap((seed) => composeAssetKeys(seed.location)));
  return findingKeys.some((key) => seedKeys.has(key));
}

export function composeScopeForPrompt(seeds: readonly Pick<FrozenTaskSeedFinding, "location">[]): ComposePromptScope {
  const locations = [...new Set(seeds.map((seed) => seed.location?.trim()).filter((value): value is string => Boolean(value)))]
    .slice(0, 8);
  return {
    mode: "seed_assets_only",
    seed_count: seeds.length,
    locations,
    rule: COMPOSE_SCOPE_RULE,
  };
}

export function composeHubInstruction(): string {
  return `组合续挖范围：工作对象仅限 YAML compose_scope.locations 对应的仓库/模块/位置。不得把本画布扩成新一轮资产扫描。imported 种子是只读背景，不是本画布可确认正本，不要为其派 Verify。${COMPOSE_SCOPE_RULE}`;
}

export function composeWorkerInstruction(locations: readonly string[] = []): string {
  const listed = locations.length > 0 ? `允许资产：${locations.join("；")}。` : "允许资产见 YAML compose_scope.locations。";
  return `组合续挖范围：${listed}禁止浅克隆或拉取种子以外的仓库；emit_finding 必须落在这些资产上或明确属于种子组合链，Scheduler 会拒收越界 Finding。`;
}

export function composeBoundWorkerPrompt(prompt: string, locations: readonly string[]): string {
  return `${prompt.trim()}\n\n【调度器范围】${composeWorkerInstruction(locations)}`;
}

export function assertComposeScopedHubIntent(
  role: string,
  from: readonly string[],
  importedSeedNodeIds: ReadonlySet<string>,
  path: string,
): void {
  if (!COMPOSE_SCOPED_ROLES.has(role)) return;
  if (![...from].some((id) => importedSeedNodeIds.has(id))) {
    throw invalidControlPayload(
      "compose 画布的 explore/audit 必须绑定至少一条 imported 种子投影，禁止未绑定的探索或全量审计。",
      path,
    );
  }
}

export function assertComposeFindingInScope(
  location: string | null | undefined,
  seeds: readonly Pick<FrozenTaskSeedFinding, "location">[],
): void {
  if (composeFindingMatchesSeedAssets(location, seeds)) return;
  throw invalidControlPayload(
    "compose 画布只接受能追溯到冻结种子资产的 Finding（同仓/同模块，或明确的组合链位置）；越界新资产已拒绝。",
    "location",
  );
}
