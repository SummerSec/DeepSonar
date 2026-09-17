# 运行镜像离线工具手册

> **状态：as-built**（#588）。索引：[`README.md`](README.md)。镜像选择见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)，OCI 目录契约见 [`RUNTIME_IMAGE_REGISTRY_CONTRACT.md`](RUNTIME_IMAGE_REGISTRY_CONTRACT.md)。

全部 13 个官方运行镜像都携带当前版本的完整工具手册，固定根目录为 `/opt/deepsonar/manuals/`。这份资料面向沙箱内 Worker，可在断网环境读取；宿主仓库文档和外部网站不属于运行时依赖。

## 镜像内契约

- `/opt/deepsonar/manuals/index.json`：机器索引，契约为 `deepsonar.runtime.manuals/v1`。
- `/opt/deepsonar/manuals/INDEX.md`：当前镜像的人类可读入口。
- `/opt/deepsonar/manuals/tools/*.md`：逐工具、包装脚本或能力入口的说明。
- `/opt/deepsonar/tool-manifest.json`：记录手册版本、路径、文件数和 SHA-256；摘要绑定当前工具清单与展开后的文档。

索引中的每个入口都有场景、选型依据、前置条件、可运行命令、输出解释、失败分类、组合流程、证据留存、版本限制、副作用和清理要求。最终镜像必须展开从基础镜像继承的工具，不能只写“参考 base”。构建脚本、下载器和 CI helper 等内部依赖应标为实现依赖，不冒充 Agent 可调用工具。

## Worker 发现与权限

Scheduler 为使用官方镜像的所有角色注入短提示：先读取索引，再按任务读取所需章节。不会把整本手册塞入每轮 prompt。Hub 使用镜像能力目录选择镜像，Worker 使用镜像内手册选择和调用工具。

手册只解释已有能力。工具执行、网络、设备、凭据、预算、Job operation 和外部副作用仍由冻结 Job 快照、Scheduler 和沙箱策略控制。设备或服务不可用时，Worker 必须按手册区分正常无结果、可修正错误、可重试失败和缺少运行条件；静态观察不能冒充真实设备、浏览器或服务行为。

## 维护和验收

权威来源为 `agent-harness/runtime-manuals/catalog.json`。工具、版本、包装入口或镜像继承变化时必须同步更新目录；手册变更计入镜像 build fingerprint，使对应镜像重新构建。

```bash
pnpm ci:unit:runtime-manuals
pnpm ci:images
node agent-harness/test-runtime-manuals-runtime.mjs <image-ref> <image-key>
```

仓库级门禁检查 13 个镜像、必填章节、工具和包装入口覆盖、禁止空泛引用以及 Dockerfile 集成。运行时门禁用 `--network none`、丢弃 capabilities 和 `no-new-privileges` 启动实际镜像，重算摘要，并确认全部文档在镜像内物理可读。依赖真机、外部服务或联网下载的示例必须在条目中标为 `device_required`、`service_required` 或 `unverified`，不得标成实测成功。
