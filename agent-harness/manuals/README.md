# 运行镜像工具说明书（#588）

每个官方运行镜像在仓库维护完整说明书，构建时安装到镜像内 `/opt/deepsonar/manuals/`。

- `catalog.json`：13 镜像与工具清单（CI 门禁权威源）
- `<imageKey>/INDEX.md`：索引
- `<imageKey>/tools/*.md`：逐工具说明（九段结构）

门禁：`agent-harness/check-runtime-image-consistency.mjs` 校验覆盖、标题完整性、Dockerfile `COPY` 与指纹路径。
