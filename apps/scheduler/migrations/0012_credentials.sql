-- CRED 工作包（§6.2）：Provider Credential 加密存储
-- 明文只存在于创建/轮换请求与运行时解密瞬间；库中只有 AES-256-GCM 密文。
-- 主密钥经 DFH_MASTER_KEY_FILE 提供（与密文不同库）；UI 只显 provider/状态/指纹/last4。

CREATE TABLE IF NOT EXISTS credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  kind                text NOT NULL,          -- llm_provider | plane | git
  provider            text NOT NULL,          -- anthropic | openai | openrouter | kimi | plane | git
  project_id          uuid REFERENCES projects(id),  -- NULL = 全局
  ciphertext          text NOT NULL,          -- base64
  nonce               text NOT NULL,          -- base64
  auth_tag            text NOT NULL,          -- base64
  key_version         int NOT NULL DEFAULT 1,
  public_metadata_json jsonb NOT NULL DEFAULT '{}',  -- 非密钥元数据（如 base_url）
  fingerprint         text NOT NULL,          -- sha256(明文)[:16]，用于识别不暴露内容
  last4               text NOT NULL,
  status              text NOT NULL DEFAULT 'active',  -- active | disabled | rotation_required
  last_used_at        timestamptz,
  rotated_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  CONSTRAINT credentials_kind_check CHECK (kind IN ('llm_provider','plane','git')),
  CONSTRAINT credentials_status_check CHECK (status IN ('active','disabled','rotation_required'))
);

-- Profile → Credential 绑定（§6.2 替换自由 env_keys：Profile 只能选已登记 Credential）
CREATE TABLE IF NOT EXISTS profile_credentials (
  profile_id    uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  purpose       text NOT NULL DEFAULT 'llm',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, credential_id, purpose)
);
