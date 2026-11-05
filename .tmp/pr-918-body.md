## 问题

凭据 `settings_config_json` 里配置的自定义上游请求头（如 `X-Traffic-Type: eval`）过去只在 `models.json` 里存在：Gateway 用固定白名单重建出站头，健康探测与目录发现也不读配置，三条路径的上游路由属性可以彼此不一致。

## 改动

- 新增 `apps/scheduler/src/provider-custom-headers.ts`：唯一的解析/校验点，只读服务器持有的凭据配置（官方 `llm-pi-ai`、扁平 `headers`、Pi `providers[*].headers` 三种形状）；同一凭据多个 provider 声明不同头集合时不做混合，直接不应用（fail closed）。
- 头名小写归一；RFC 7230 token 校验 + 长度上限（名字 128 / 值 1024）+ 条目上限 16；拒绝 CR/LF/NUL。
- 拒绝配置：认证载体（`authorization`、`x-api-key`、`anthropic-api-key`、`proxy-authorization`）、framing/hop-by-hop（`host`、`content-length`、`content-type`、`accept`、`connection`、`transfer-encoding`、`te`、`upgrade`…）、协议与 CLI 身份（`user-agent`、`x-app`、`anthropic-*`）、内部/代理控制（`x-deepsonar-*`、`proxy-*`）、`cookie`/`set-cookie`。
- 生效顺序（低 → 高）：framing → 受信协议默认值 → 凭据配置头 → Gateway 允许透传的 CLI 协议头 → 最终认证。`upstreamAuthHeaders` 拆成 `upstreamProtocolHeaders` + `upstreamFinalAuthHeaders`，让 CLI 的 `user-agent` 仍能覆盖指纹默认值，而认证只由当前绑定凭据生成。
- 同时修掉入站头 `anthropic-api-key` 经 `/^anthropic-/` 前缀透传的 Job token 外发路径：透传改为精确头名集合（`user-agent`、`x-app`、`anthropic-version`、`anthropic-beta`）。
- `credential-test.ts` 的目录发现与推理探测改用同一解析器，和真实 Job 同口径。
- Observational Memory 别名仍剔除 `headers`/`baseUrl`，本改动不恢复沙箱对 endpoint / 请求头的覆盖能力。

## 验证

- `npx tsx --test src/provider-custom-headers.test.ts src/gateway-usage.test.ts src/credential-test.test.ts` → 46 pass / 0 fail。
- 新增 `gateway-provider-headers.integration.test.ts`：假上游断言实际收到 `x-traffic-type: eval`（而不是沙箱伪造值）、`x-tenant`、透传的 `user-agent`，且**没有任何头值携带入站 Job token**、没有 `anthropic-api-key`、认证来自绑定凭据。该用例需要 `TEST_DATABASE_URL`，本机无凭据，按仓库约定在 Actions 执行。
- `npx tsc -p apps/scheduler/tsconfig.json --noEmit` 通过；`docs-freshness`、`file-size`、`ci-test-hook` 三个守则套件本地通过；新用例已挂入 `ci:unit:executor-real` 与 `ci:integration:platform-api`。

## 未覆盖

- 现场 429 与丢头的因果关系仍未证明（本单只闭合静态可达的丢头与 token 外发路径）。
- 未做真实模型/真实中转验证，按仓库验收边界以 Actions 为准。