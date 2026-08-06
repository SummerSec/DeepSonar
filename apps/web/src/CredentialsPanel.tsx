import { useEffect, useState } from "react";
import { api, type Project, type ProviderCredential } from "./api";
import { ProviderAccountFlow } from "./ProviderAccountFlow";

/**
 * Provider 凭据页：仅托管 ProviderAccountFlow（列表 / 添加 / 编辑 / 绑定）。
 * 旧三列卡片列表已移除，避免与上方账号列表重复。
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
