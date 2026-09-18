import type { ProviderCredential, ProjectSettings } from "../api";
import { ProjectCliProviderAllowlistPanel } from "./ProjectCliProviderAllowlistPanel";
import { ProjectModelPolicyPanel } from "./ProjectModelPolicyPanel";

/** CLI/Provider + model policy panels driven by project settings (control plane). */
export function ProjectCompositionPolicyPanels({
  projectId,
  credentials,
  settings,
  onSaved,
}: {
  projectId: string;
  credentials: ProviderCredential[];
  settings: ProjectSettings | null;
  onSaved: () => void;
}) {
  const credIds = settings?.enabled_credential_ids ?? [];
  return (
    <>
      <ProjectCliProviderAllowlistPanel
        projectId={projectId}
        credentials={credentials}
        enabledAgentClis={settings?.enabled_agent_clis?.length ? settings.enabled_agent_clis : ["claude-code"]}
        enabledCredentialIds={credIds}
        defaultAgentCli={settings?.default_agent_cli ?? null}
        defaultCredentialId={settings?.default_credential_id ?? null}
        onSaved={onSaved}
      />
      <ProjectModelPolicyPanel
        projectId={projectId}
        credentials={credentials}
        enabledCredentialIds={credIds}
        enabledModelIds={settings?.enabled_model_ids ?? []}
        defaultModelId={settings?.default_model_id ?? null}
        fallbackModelIds={settings?.fallback_model_ids ?? []}
        modelPolicyConfigured={Boolean(settings?.model_policy_configured)}
        onSaved={onSaved}
      />
    </>
  );
}
