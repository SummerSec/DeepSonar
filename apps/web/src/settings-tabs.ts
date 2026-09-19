import type { AuthMe } from "./api";
import { canAccessAnyScope } from "./permissions";

export type SettingsTab =
  | "rules"
  | "roles"
  | "bindings"
  | "sources"
  | "tokens"
  | "credentials"
  | "transfer"
  | "users"
  | "account"
  | "assets";
export type GlobalSettingsSection = "agents" | "modules" | "access" | "credentials" | "platform";

export const PROJECT_TAB_KEYS: readonly SettingsTab[] = ["rules", "roles", "assets"];
export const GLOBAL_TAB_KEYS: readonly SettingsTab[] = [
  "roles", "bindings", "sources", "rules", "assets", "account", "users", "transfer", "credentials", "tokens",
];
export const GLOBAL_SECTION_TABS: Record<GlobalSettingsSection, readonly SettingsTab[]> = {
  agents: ["roles", "bindings"],
  modules: ["sources"],
  access: ["account", "users", "tokens"],
  credentials: ["credentials"],
  platform: ["rules", "assets", "transfer"],
};
const GLOBAL_TAB_SCOPES: Partial<Record<SettingsTab, readonly string[]>> = {
  roles: ["agents:read"],
  bindings: ["agents:read"],
  sources: ["skills:read"],
  rules: ["agents:read"],
  account: ["projects:read"],
  users: ["admin"],
  transfer: ["exports:read", "imports:read"],
  credentials: ["agents:read"],
  tokens: ["tokens:manage"],
  assets: ["assets:manage"],
};

export function settingsTabsForActor(section: GlobalSettingsSection, me: AuthMe | null): readonly SettingsTab[] {
  return GLOBAL_SECTION_TABS[section].filter((tab) => canAccessAnyScope(me, GLOBAL_TAB_SCOPES[tab] ?? ["admin"]));
}

/** Resolve a URL tab without allowing project pages to expose global-only tabs. */
export function resolveSettingsTab(projectId: string | null, requested: string | null): SettingsTab {
  const allowed = projectId ? PROJECT_TAB_KEYS : GLOBAL_TAB_KEYS;
  return requested && (allowed as readonly string[]).includes(requested) ? requested as SettingsTab : "roles";
}

export function resolveSettingsSectionTab(section: GlobalSettingsSection, requested: string | null): SettingsTab {
  const allowed = GLOBAL_SECTION_TABS[section];
  return requested && (allowed as readonly string[]).includes(requested) ? requested as SettingsTab : allowed[0]!;
}

export function settingsSectionDataNeeds(projectId: string | null, section: GlobalSettingsSection) {
  return {
    agent: Boolean(projectId || section === "agents"),
    modules: Boolean(projectId || section === "agents" || section === "modules"),
    roleCredentialBindings: Boolean(projectId || section === "agents"),
  };
}

export const ROLE_BINDING_HREF = "/agents?tab=bindings";
export const CREDENTIAL_ACCOUNT_HREF = "/settings/credentials";
