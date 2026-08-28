/** Local RoleConfig materialization types. Provider SDKs must not leak these. */

export interface AgentCommandConfig {
  name: string;
  description?: string;
  template: string;
}

export interface AgentSubAgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  instructions: string;
}

export type AgentSkillConfig =
  | { name: string; files: Record<string, string> }
  | { name: string; repo: string; files?: undefined };

export type AgentMcpConfig =
  | {
      name: string;
      enabled?: boolean;
      type: "remote";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      name: string;
      enabled?: boolean;
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
