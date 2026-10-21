# 自动升级签名准入（#740 P2）

> 状态：独立实现与隔离测试；生产签名未启用
> 同步日期：2026-10-21

平台签名验证入口为 [platform-upgrade-signature.mjs](platform-upgrade-signature.mjs) 的 `verifyPlatformSignatures({target, policy})`，也提供 `verifySignedPlatformTarget(target, policy)`。成功返回 `verified: true`、`targetSha256` 和逐服务证据；禁用、缺签名、工具/信任根不符或任何验签失败都抛固定错误，不返回“跳过即通过”。调用者仍须执行版本、schema、配置、维护窗口及排空策略；签名不授予升级权限。

## 签名覆盖与信任边界

`target` 包含无 `v` 前缀的稳定 `version`、完整 `commit_sha`、正整数 `schema_version`，以及 `images` 下 scheduler、web、image-admission 三个完整不可变引用。首版只接受 `ghcr.io/summersec/deepsonar-<service>@sha256:…`，不接受 ACR/Docker Hub 路由替换。签名的 OCI index digest 绑定其子 manifest；本入口不接受独立 child 引用冒充已核准 index。

每份签名的 annotations 绑定 `deepsonar.version`、`deepsonar.commit`、`deepsonar.schema`、`deepsonar.service`、`deepsonar.repository` 和三张镜像及上述元数据的规范化 `deepsonar.target-sha256`。合法旧 digest 与伪造新补丁版本、错误 schema 或另一组镜像的混搭会被拒绝。

验证使用固定 Cosign `v3.1.4`，精确要求 GitHub OIDC issuer `https://token.actions.githubusercontent.com`、仓库 `SummerSec/DeepSonar`、`release.yml@refs/tags/v<version>` 身份、对应 workflow ref 和 commit SHA。采用现代 Sigstore bundle：`verify-attestation --type https://sigstore.dev/cosign/sign/v1` 验证证书链、透明日志及签名后，程序再解析已验证 DSSE，核对 subject digest 与所有 annotations。不能只凭退出码或 `cosign verify` 的精简输出放行；后者转换会丢弃 annotations。本入口没有关闭透明日志、证书或声明检查的选项。

`policy` 必须来自独立受管宿主配置，不能来自待升级 Release：`enabled: true`、`cosignPath`、`cosignSha256`、`trustedRootPath`、`trustedRootSha256` 均须明确设置。管理员应通过可信分发渠道预置 Sigstore trusted-root 文件并钉死其 SHA-256；本实现不从目标清单自动采信或更新信任根。程序核对工具与根文件内容后复制到私有临时目录再执行，避免校验后重开可变原路径。Windows 复用原生私有目录/DACL 文件后端；此处尚无 Windows 原生 cosign 实跑证据。

## 发布准备与待审批接线

[发布程序](../agent-harness/platform-signature-release.mjs) 默认只生成计划；[计划模块](../agent-harness/platform-signature-plan.mjs) 不请求 OIDC、写 registry 或增加权限。以 stdin 输入 `{target, github}` 可离线审查计划，`github` 只用于计划。显式 `--execute --policy <host-policy.json>` 才执行 `cosign sign -a …`，并在完成后三镜像重新验证成功才报告 `signed_and_verified`。执行身份只从实际 GitHub Actions 环境读取，不接受 stdin 冒充 tag/workflow；缺少 OIDC 请求凭据即阻断。失败可能留下已发布的部分签名，不能报告全部完成；同一目标可重新验证/补签。

```bash
# 仅生成计划，不签名、不发布
node agent-harness/platform-signature-release.mjs < reviewed-signature-input.json
# 仅在权限获批且 tag workflow 身份符合目标的 Release job 执行
node agent-harness/platform-signature-release.mjs --execute --policy /private/signature-policy.json < reviewed-signature-input.json
```

当前 `release.yml` **未接执行入口、未增加权限、未启用生产签名**。最小待审批变更是已有 release workflow 的独立签名 job，仅允许真实目标 tag，增加该 job 的 `id-token: write`（向 GitHub OIDC 请求短期身份并由 Fulcio 签发证书），保留读取源码/制品及推送 GHCR 签名所需的 `contents: read` / `packages: write`。不创建持久私钥，不增加 OAuth 应用或仓库全局令牌权限。还需要访问 Sigstore Fulcio/Rekor/信任元数据服务及 GHCR；签名会进入公开透明日志。示意片段只供审批，不能据此宣称工作流已启用：

```yaml
platform-signatures:
  if: ${{ vars.DEEPSONAR_PLATFORM_SIGNING_ENABLED == 'true' && startsWith(github.ref, 'refs/tags/v') }}
  permissions:
    contents: read
    packages: write
    id-token: write
  # depends on all three platform index descriptors and final inspect validation
  # checkout the exact tag SHA; install pinned cosign; pre-provision pinned trusted-root
  # build target JSON from the validated manifest's three GHCR index references
  # set DOCKER_CONFIG to the existing GHCR login config (no credentials in argv)
  # run the explicit --execute command above, then require signed_and_verified
```

手动从 main/任意分支触发的 release 不能自动冒充 tag 证书身份；选择 tag 运行且 checkout/ref/SHA 一致后才可签名。原有通道复制不会自动复制本签名契约的 repo 身份；在各通道分别签名并增加明确验证策略前，其他通道继续拒绝自动升级。

## 验证证据与限制

`deploy/platform-upgrade-signature.test.mjs` 覆盖禁用拒绝、精确身份参数、元数据/镜像混搭、损坏或空输出、工具/根 hash、发布权限检查和脱敏错误。使用假 CLI 的测试只验证调用边界，不证明 keyless 密码学链路。

`deploy/platform-upgrade-signature.integration.test.mjs` 需要显式 `DEEPSONAR_TEST_COSIGN` 和 `DEEPSONAR_TEST_COSIGN_SHA256`。本次使用官方 [v3.1.4](https://github.com/sigstore/cosign/releases/tag/v3.1.4) Linux amd64 工具，SHA-256 `424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa` 与官方 checksums 一致。真实临时测试密钥签名/验签、错误公钥、内容篡改与签名篡改拒绝通过，临时密钥和 bundle 全部清理。只有这个隔离密钥测试省略透明日志，生产验证接口不提供该旁路。CI 可下载安装同一固定二进制并传入上述两变量；未提供时测试明确跳过。

尚未执行真实 release.yml keyless 签名、Fulcio/Rekor 身份链正向验收、其他 registry 通道签名或 Windows 原生 cosign 验收。P2 不因隔离算法测试通过而成为已启用的无人值守生产能力。官方机制参考 [Sigstore 验签说明](https://docs.sigstore.dev/cosign/verifying/verify/) 与 [固定版本验证实现](https://github.com/sigstore/cosign/tree/v3.1.4/cmd/cosign/cli/verify)。

## 自动补丁入口与维护窗口

`./deploy/deploy.sh upgrade auto` 未指定策略时返回 `policy_disabled`，不接触 Docker。显式策略由 `--policy /absolute/private-policy.json` 指定；PowerShell 对应 `upgrade auto -Policy C:\private\policy.json`。参考 [默认关闭的策略](platform-upgrade-auto-policy.example.json)，管理员须分别启用自动策略及签名策略并预置可信工具/根文件。Linux 策略文件要求私有权限（例如 `chmod 600`）；Windows 要求当前用户与 SYSTEM 的受保护私有 DACL。不要把签名信任配置从待验证清单导入。

窗口使用 IANA 时区、ISO 星期一=1 至星期日=7、HH:mm 开始/结束；开始包含、结束不包含，跨午夜归开始日。只允许同 major/minor 的稳定补丁上升，真实运行版本须与部署配置一致；schema 及源/目标 SQL 指纹相同、无风险项、完整预检通过且三个镜像签名全部验证后才创建升级代。下载/预检后会重检窗口，不传入隐式风险审批或角色身份重置。

自动授权记录绑定目标、计划、部署和策略，与维护 journal 同锁保护。同一已授权代可在窗口外安全续做，并重新验签；不发现或切换到另一个新目标。排空超时、回滚或结果不明仍要求人工处理。显式禁用策略后自动入口不做恢复；管理员应按维护记录恢复。成功激活是仅向前修复边界，不允许回旧库覆盖新写入。

## 默认禁用的宿主调度模板

```bash
./deploy/deploy.sh upgrade auto-template --scheduler systemd --policy /absolute/private-policy.json --node-path /absolute/node
```

```powershell
.\deploy\deploy.ps1 upgrade auto-template -Scheduler windows -Policy C:\private\policy.json -NodePath C:\node\node.exe
```

输出 JSON 内含文件名与内容，不写文件、不调用调度服务。systemd 输出 `.service.disabled` / `.timer.disabled`，管理员审阅、配置运行身份和既有管理员 token 的安全来源后，才可明确改名安装并启用。Windows XML 的 `Settings.Enabled=false`，导入后仍需管理员显式启用。模板每小时唤起策略检查，真正的新升级还受维护窗口控制；模板不嵌入 token、不申请 OAuth 权限、不创建任何新密钥。
