# Extension / Tool Materialization Registry

统一扩展与工具物化注册表（#615）。平台登记组件；Job 创建时冻结版本与 digest；Scheduler 仅物化已冻结组件。Job 运行阶段默认禁止 `npx` / `npm install` / `pip install` / 远程脚本安装，失败码为 `component_materialization_failed`。

## Phase 1 范围

- 契约：`deepsonar.extension-materialization/v1`（`@deepsonar/shared-types`）
- 目录种子：现有 Pi Extension（如 `pi.extension.pi-web-access`）
- Job 快照字段：`component_materialization_pack`
- 运行时门禁：拒绝 repo skill 的动态 `skills add`

## 组件字段（摘要）

`component_id`、`type`、`source_kind`、`source`、`version`、`digest`、`compatible_agent_clis`、`compatible_image_keys`、`allow_network`、`entry`、`manuals_path`、`runtime_limits`、`security_level`、`maintenance_status`

## pi.extension.pi-web-access

- 类型：`pi_extension` / `image_preinstall`
- 包：`pi-web-access`（版本与 integrity 以 `PI_EXTENSION_REGISTRY` 为准）
- 兼容镜像：`deepsonar-audit`、`deepsonar-kali-minimal`
- 需要出网能力声明；断网 Job 由既有 Pi 扩展物化路径跳过注入

## Follow-up

- 将 repository Skill / 更多工具包迁入注册表
- UI 展示组件来源、版本、digest 与物化状态
- 镜像构建期物化与完整性校验扩写
