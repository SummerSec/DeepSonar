# v0.1.0 运行时镜像发布

`.github/workflows/release.yml` 由 `v*` tag 触发。工作流先发布 `deepsonar-base`，再发布依赖它的 OpenHarmony Test 镜像，最后由一个 Release job 合并真实的 buildx manifest digest，上传 `runtime-image-registry.json` artifact，并把它与 Management Skill 一起作为 GitHub Release 附件。

## 可选发布凭据

Docker Hub 运行时镜像使用以下 GitHub Actions Secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

中国区阿里云 ACR 同步必须四项同时配置，否则工作流会在 Step Summary 明确说明并只发布 GHCR/Docker Hub：

- `ALIYUN_REGISTRY`：完整 registry host，例如 `crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com`
- `ALIYUN_REGISTRY_NAMESPACE`
- `ALIYUN_REGISTRY_USERNAME`
- `ALIYUN_REGISTRY_PASSWORD`

ACR 标签与 GHCR/Docker Hub 标签在同一次 buildx 多平台发布中生成。四项 ACR Secret 齐全时，最终 runtime registry 清单优先写入 ACR 的 `name@sha256:<manifest-digest>`；否则写入 GHCR 的相同真实 digest。工作流不会硬编码任何凭据。

ACR 仓库需要设为公开或启用匿名拉取，才能供中国区部署直接使用。公网访问请按最小范围配置，仅开放必要仓库和拉取权限；不要为发布账号授予超出镜像推送所需范围的权限。

## 清单与校验

清单由 `agent-harness/generate-runtime-image-registry.mjs` 根据各镜像 `build-push-action` 输出的真实 digest 生成，包含 Base、Audit、Kali Minimal 和 OpenHarmony Test 四项。发布步骤通过 OCI index/manifest 记录各平台压缩层大小，并以单个平台最大压缩大小写入 `size_bytes`。静态模板只保存镜像市场元数据，不伪造版本或 digest。Scheduler 定时读取官方 GitHub Release 的最新清单；新正式版本成为默认 promoted 版本，旧版本只保留给显式项目 pin 与历史 Job 快照。

本地可运行：

```bash
node agent-harness/check-runtime-image-consistency.mjs
git diff --check
```
