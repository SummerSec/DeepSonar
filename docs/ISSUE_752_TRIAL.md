# #752 独立分支试运行产物

状态：试运行交付说明；不是正式 Release。仅 `codex/issue-752-project-knowledge` 分支推送触发 `issue-752-trial.yml`。同一工作流先完成 TypeScript、构建、项目知识集成等检查，再在 GitHub 的一次性 Linux runner 上执行真实 Dispatcher → OpenSandbox → Claude Code → Control API 跨项目授权与撤销冒烟；这些步骤成功后才构建三个 `linux/amd64` 控制面镜像并上传 Actions artifact。工作流没有 registry push、`v*` tag、Release、catalog 改写或自动部署。新 workflow 尚未在默认分支注册时，GitHub UI/API 可能不提供 `workflow_dispatch`；分支 `push` 是预期入口，不为注册工作流合并主线。

产物 `issue752-<完整 40 位 commit SHA>-linux-amd64` 含三个 `docker save` 归档：Scheduler、Web、image-admission，镜像名分别为 `issue752/deepsonar-<component>:issue752-<SHA>`。根目录的 `SHA256SUMS` 覆盖归档、镜像 ID 文件和 `metadata.json`；metadata 记录完整源码 SHA、`linux/amd64`、镜像 ID、归档大小与哈希。`deployment/` 保存只供试运行的 Compose 资料、独立端口/卷模板、schema v61 源码与本说明。官方 Agent runtime 镜像没有重建，真实 Job 使用仓库已批准 registry 中的不可变 digest；工作流冒烟使用已发布 Reverse runtime 的 digest。

**只在独立、空白的 Linux Docker 测试主机试跑。** 当前运行时的 `deepsonar-gateway-proxy` 容器名以及 `deepsonar-sandbox-gateway` / `deepsonar-restricted` 网络名在代码中固定。即使 Compose 的项目名、业务网络、socket 卷、OpenSandbox 容器名和端口已改成 `issue752-*`，仍不能保证与同一宿主机上的业务部署隔离。不要在现有业务 Docker/Podman 主机上运行以下命令，也不要把产物的空库配置指向业务 PostgreSQL 或业务卷。产物本身只上传文件，不启动任何容器。

在独立主机上下载并解压 artifact 后，从解压目录执行：

```bash
sha256sum -c SHA256SUMS
for name in scheduler web image-admission; do
  docker load --input "images/deepsonar-${name}.tar"
  expected="$(cat "images/deepsonar-${name}.id")"
  image="$(node -e 'const m=require("./metadata.json"); console.log(m.images.find(x=>x.component===process.argv[1]).image)' "$name")"
  test "$(docker image inspect --format '{{.Id}}' "$image")" = "$expected"
done
```

`deployment/deploy/.env.example` 已将 PostgreSQL、Web、Silo 与 OpenSandbox 的宿主端口改为 `55432`、`18080`、`19000`/`19001`、`28081`；Compose 项目、业务网络、admission 卷、gateway socket 卷和 OpenSandbox 容器采用试运行专用名称。此模板没有可用凭据。先复制为 `deployment/deploy/.env`，逐一替换所有 `change-me-*`，为 `OPEN_SANDBOX_API_KEY`、数据库、管理员引导 Token、Silo 生成互不相同的随机值，设置 `chmod 600`；用独立随机主密钥创建 `deployment/deploy/master.key`（例如 `openssl rand -hex 32 > deployment/deploy/master.key && chmod 600 deployment/deploy/master.key`）。使用 Docker rootless/Podman 时，还需核对模板中的 socket 与磁盘路径。**不要复制任何现有业务 `.env`、`master.key` 或数据库卷。**

真实 Job 启动前，按 `deployment/deploy/runtime-image-registry.json` 选择当前平台已准入、`linux/amd64` 且不可变的官方运行时 digest，填入所需 `DEEPSONAR_OFFICIAL_*_IMAGE` 值；不要把 `issue752` 控制面镜像标签当作 Agent runtime digest。初次试跑必须让 Compose 创建新空库，并确认包含 `project_knowledge_*` 表的 schema 基线是 v61；这里不提供 v59 业务库原地升级路径。

配置完后，先审阅渲染结果，再手动启动。下面的命令只适用于上述独立主机：

```bash
cd deployment
# 此时 deploy/.env 已由上一步从模板复制、填入独立凭据；master.key 也已创建。
docker compose -p issue752-trial --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml -f deploy/docker-compose.real.yml \
  -f deploy/docker-compose.opensandbox.prod.yml -f deploy/issue752-trial.override.yml config --quiet
docker compose -p issue752-trial --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml -f deploy/docker-compose.real.yml \
  -f deploy/docker-compose.opensandbox.prod.yml -f deploy/issue752-trial.override.yml \
  up -d --pull missing --no-build
curl -fsS http://127.0.0.1:18080/api/health
```

`--no-build` 保证只消费归档加载的三个控制面镜像；`--pull missing` 仅为未加载的 PostgreSQL、Silo、OpenSandbox 等基础镜像获取依赖。运行前用 `docker image inspect` 再核对三个 `issue752-<SHA>` 标签存在。`deploy.sh up real pull` 会主动向 registry 拉控制面镜像，不能用于本离线归档。关闭试运行环境时，先在该独立主机审阅 Compose 资源，再执行同一组 `-p` / `-f` 参数的 `down`；是否删除试验卷应在确认不需保留数据后单独决定。

真实冒烟的 Actions artifact `issue752-<SHA>-live-authorization` 保存 `knowledge-job-smoke.json`；它验证真实执行与跨项目读取边界，不代表 maker → trial → evaluator → reviewer 的完整模型效果或生产部署。归档产物仅在前置 checks 和该冒烟均成功后上传；首次分支运行结果及任何失败日志仍需人工核对。
