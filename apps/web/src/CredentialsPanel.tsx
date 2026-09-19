import { useEffect, useState } from "react";
import { api, type Project, type ProviderCredential } from "./api";
import { ProviderAccountFlow } from "./ProviderAccountFlow";

/**
 * Provider 凭据页：仅托管账号 CRUD / 健康 / 只读引用。
 * 角色绑定与快照生效在 Agent「凭据绑定」，不在此页提交。
 */
export function CredentialsPanel() {
  const [creds, setCreds] = useState<ProviderCredential[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    api.credentials().then(setCreds).catch((e) => setError(String(e)));
    api.projects().then(setProjects).catch(() => {});
  };
  useEffect(load, []);

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <ProviderAccountFlow credentials={creds} projects={projects} onChanged={load} />
      {error && <div className="text-[12px] text-red-400">{error}</div>}
    </div>
  );
}
