# 运行时镜像发布（Issue #70 Slice B）

> **状态：运维 as-built**。改 CLI 钉死版本后须打 `v*` 才会重建官方 Agent 镜像。索引：[`README.md`](README.md)。

`.github/workflows/release.yml` 由 `v*` tag 触发。工作流先发布 `deepsonar-base`，再发布依赖它的 OpenHarmony、Chrome 与 Mobile 专项镜像，最后由一个 Release job 合并真实的 buildx manifest digest，上传 `runtime-image-registry.json` artifact，并把它与 Management Skill 一起作为 GitHub Release 附件。合并前的核心定义与 base/audit/Kali 门禁在 `.github/workflows/ci.yml`；Chrome amd64 合同冒烟在 `.github/workflows/chrome-runtime.yml`，OpenHarmony test/audit/fuzz amd64/arm64 专项冒烟在 `.github/workflows/openharmony-runtime.yml`，Mobile amd64/arm64 专项冒烟在 `.github/workflows/mobile-runtime.yml`。

同一 Release job 在校验通过后，会把生成的 `deploy/runtime-image-registry.json` **提交并推送到仓库默认分支**（`chore(release): sync runtime-image-registry.json for vX.Y.Z`），用于更新内置 bundled 回退清单。仅当默认分支内容与本次发布不同时才提交；推送到默认分支不会再次触发本 workflow（触发条件只有 `v*` tag）。若默认分支开启了「禁止 GITHUB_TOKEN 直推」类保护规则，需为 Actions 放行或改用可写 PAT。

## 发布前门禁

生产变更记录维护在根目录 [CHANGELOG.md](../CHANGELOG.md)。产品版本的唯一来源是不可变的 `vX.Y.Z` Git tag；根目录和第一方 workspace 的私有 package 版本是内部元数据，不参与 Release 版本解析。每个正式版本必须有一个非空、日期有效的 changelog 区段，并带有精确匹配 `vPrevious...vCurrent` 的 compare link。

发布前在干净的合并提交上运行：

```bash
pnpm ci:unit:changelog
pnpm typecheck
pnpm build
pnpm ci:images
```

随后等待 `main` CI 通过，再创建并推送新的不可变 `vX.Y.Z` tag。Release workflow 会在镜像构建前再次校验 tag、目标 changelog 区段和 compare link；校验失败时不会构建或发布镜像。工作流将经过校验的精确 changelog 区段写入 GitHub Release，同时保留许可证声明、runtime registry、Management Skill 附件和 GitHub 生成的 compare notes。

## 可选发布凭据

Docker Hub 运行时镜像使用以下 GitHub Actions Secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

中国区阿里云 ACR 同步必须四项同时配置，否则工作流会在 Step Summary 明确说明并只发布 GHCR/Docker Hub：

- `ALIYUN_REGISTRY`：完整 registry host，例如 `crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com`
- `ALIYUN_REGISTRY_NAMESPACE`
- `ALIYUN_REGISTRY_USERNAME`
- `ALIYUN_REGISTRY_PASSWORD`

ACR、GHCR 与 Docker Hub 标签在同一次 buildx 多平台发布中生成。清单保留每个已发布目的地的不可变引用和 inspect 证据；没有配置的可选目的地明确记录 unavailable，不会用 ACR/GHCR 优先级猜测替代。工作流不会硬编码任何凭据。

ACR 仓库需要设为公开或启用匿名拉取，才能供中国区部署直接使用。公网访问请按最小范围配置，仅开放必要仓库和拉取权限；不要为发布账号授予超出镜像推送所需范围的权限。

## 清单与校验

清单由 `agent-harness/generate-runtime-image-registry.mjs` 根据各镜像构建输出的真实 digest 生成，包含 Base、Audit、Kali Minimal、OpenHarmony Test、OpenHarmony Audit、OpenHarmony Fuzz、Chrome Audit、Chrome Test、Chrome Fuzz 与 Mobile 十项。Chrome / Mobile 条目在源码内置 bundled 清单中可以保持 `versions: []`；只有 Release 对两个平台完成真实构建、发布和 inspect 后，生成器才会写入版本与 digest。

**一版本多平台**：v2 多架构发布时，每个产品在 `versions[]` 只有一条 canonical 记录，`platforms` 同时列出 `linux/amd64` / `linux/arm64`，`digest` 是共享 manifest/index digest，`size_bytes` 为目标平台压缩层大小上限。旧 v1 清单仍按一平台一版本兼容解析；Scheduler 当前只消费 v2 的 GitHub `image_ref` 投影。

**真实 digest 只来自本次 Release 的构建输出**，不会手写伪造。发布成功后：

1. GitHub Release 附件（Scheduler 优先拉取的 remote 目录）  
2. 仓库内 `deploy/runtime-image-registry.json`（bundled 回退，由 workflow 自动回写默认分支）

Scheduler 定时读取官方 GitHub Release 的最新清单；失败时回退仓库内置清单。新正式版本成为默认 promoted 版本，旧版本只保留给仍可执行的显式项目 pin、`pin_policy=hold` 与历史 Job 快照。`selected_version_id=null` 跟随最新 trusted。权威 catalog apply 后，已过期的官方项目 pin（当前通道/宿主平台不再可执行 trusted，且新 latest trusted 可用）会自动滚到最新 trusted，并写 `runtime_image.official_pin_roll` 审计。`pin_ok` 的显式旧版、第三方 pin 与 `hold` 不自动改写；后者过期时预检与建任务仍返回 `409 RUNTIME_IMAGE_PIN_STALE`，市场行带 `pin_stale`，可一键升级或改为跟随最新。

GHCR 包说明来自 OCI 元数据。Dockerfile 为单平台 manifest 写入 `org.opencontainers.image.title`、`description`、`source` 与 `licenses`；Release workflow 同时把这些值写入多架构 image index annotation。项目源码使用 `LicenseRef-DeepSonar-Proprietary`，但镜像内第三方组件仍分别适用其自身许可证，详见根目录 `THIRD_PARTY_NOTICES.md` 与随镜像生成的组件清单。修改说明后必须重新发布镜像，既有 digest 的包页面不会被原地改写。

本地可运行：

```bash
node agent-harness/check-runtime-image-consistency.mjs
git diff --check
```

## Slice B release contract

The release workflow is the source of truth for the v2 catalog. It publishes
each image to configured destinations in this order: Aliyun ACR, GHCR, then
Docker Hub. ACR and Docker Hub are optional; missing credentials produce an
explicit unavailable channel record rather than a guessed reference.
The official ACR endpoint is fixed to
`crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec`; a
different host/namespace is rejected by the server-owned catalog policy.

Every destination that is published is checked with
`docker buildx imagetools inspect`. Its registry-reported `Digest:` must equal
the build canonical digest before `record-runtime-image-digest.mjs` writes a
descriptor. Copy operations retry with bounded exponential backoff. If any
configured channel exhausts retries, the workflow sets
`CHANNEL_PUBLISH_FAILED`; the recorder fails closed and the release job cannot
generate a partial catalog. The old raw-JSON hash shortcut is not valid OCI
evidence.

Descriptors contain `registry_records` (availability, immutable ref,
`inspect_digest`, provenance/reason) and are merged into one
`deepsonar.registry/v2` version per product with all target platforms. The
descriptor must carry all three channel outcomes; generated v2
`registry_evidence` contains exactly `github`, `dockerhub`, and `aliyun-acr`,
with GitHub available and inspected for the public release baseline. Scheduler
adds `fallback`, `error`, and `checked_at` after parsing; those fields are not
accepted as upload-controlled catalog input.
Available provenance is fixed to `build-push+inspect` for GitHub and
`cross-registry-copy+inspect` for Docker Hub/ACR; unavailable reasons are
bounded single-line tokens.
release uploads `runtime-image-registry-v2.json` and synchronizes the bundled
v2 fallback. Scheduler Slice C stores a platform-global selected channel
(`github`, `dockerhub`, or `aliyun-acr`) and consumes only that channel's
immutable reference for apply, pull, and Job snapshots. If an internal
channel-only item has no reference for the selected channel, it is skipped or
fails closed; the Scheduler never substitutes another channel or rewrites an
existing Job snapshot.

## Chrome specialist release contract

The Chrome source pins are kept in `deploy/chrome-runtime-sources.json` and are
consumed by the three Chrome Dockerfiles and the consistency gate:

- Chromium `151.0.7922.71-1~deb12u1` is installed from Debian bookworm-security
  snapshot packages. The amd64 and arm64 package URLs, sizes, and SHA-256
  values are pinned separately, including the exact-version `chromium-common`
  package closure; the package is never downloaded from a moving `stable` URL.
- `playwright-core@1.62.1` is installed with its npm integrity value. The test
  smoke launches the image's governed Chromium wrapper and connects through
  the CDP endpoint with Playwright; it is not a host-browser smoke.
- Chrome Fuzz 固定 checkout depot_tools 提交
  `921e61b35fbc5e97b14250a118e363ec05078089` 与 V8 提交
  `792d9716fea48312ad7ce4413c538e00628b1d50`（V8 `15.1.206.10`，来自 Chromium
  `151.0.7922.71`），然后针对目标架构运行 `autoninja d8
  v8_json_libfuzzer`。amd64 按正常目标架构构建；arm64 在 x86 runner 上使用固定
  Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装。Chromium 包版本与
  V8 源码版本分别记录，因为它们是独立固定的输入。`chrome-fuzz-env.sh` 与
  `chrome-fuzz-smoke.sh` 拒绝缺失或非 V8 二进制，并使用 `-runs=1` 执行真实 V8
  libFuzzer 目标；arm64 的真实 smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，
  原生 smoke 通过前不得组装发布 index。Release 必须证明 `linux/amd64` 与
  `linux/arm64` 均生成真实目标；若 arm64 源码构建不能生成实际 d8，发布不完整，
  不得向 registry 写入 digest。

The Chrome images are all project opt-in and have no global role defaults.
`chrome-runtime.yml` builds amd64 and runs the contract/smoke harness when its
Dockerfiles, descriptors/scripts, `.dockerignore`, shared fingerprint/cache
mechanism, or workflow changes. `release.yml` is the authoritative
multi-architecture gate：Chrome Fuzz amd64 按正常目标架构构建，arm64 在 x86 runner
上使用固定 Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装；arm64 的
真实 d8/libFuzzer smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，只有原生 smoke
通过后才允许 `chrome-images` 组装两个子 digest 的发布 index。它使用不可变 base
digest，发布 GHCR 以及配置的 ACR、Docker Hub 标签，检查每个目标，并且只上传
`record-runtime-image-digest.mjs` 接受的记录。

## OpenHarmony specialist CI contract

`openharmony-runtime.yml` covers test, audit, and fuzz on `linux/amd64` and
`linux/arm64`. It uses QEMU for builds, runs the offline environment checks, and
pins one immutable GHCR `src-*` tag per architecture. OpenHarmony Test smoke is
`hdc version` / `hdc -v` plus the source-tool check; either command reporting
`Ver:` is enough (qemu/no-daemon may print `Connect server failed` on the
other), and it must not require a real device. It is path-filtered to the
OpenHarmony Dockerfiles, the `openharmony-*.sh` scripts, the vendored
`gitcode-repo-py3` launcher and official `toolchains/hdc` slice, the Test
runtime manifest, `.dockerignore`, the shared
fingerprint/cache scripts, and its own workflow file. Release still publishes
all three OpenHarmony products.
