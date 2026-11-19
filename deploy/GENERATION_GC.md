# 历史候选数据库回收（#1124 B）

> 状态：实现与隔离回归已接线，最终提交的 GitHub Actions 待验。
> 同步日期：2026-11-19

维护升级每次创建独立候选库。显式维护入口回收退出恢复保留集且归属可证明的历史候选库。默认预览不写数据库业务状态，列出每库估算字节数、保留原因和可回收总量，在宿主私有恢复目录保存计划。

## 操作入口

先生成预览，核对 candidates、retained、reclaimable_bytes 和 plan_hash，再以该 hash 明确执行。

```sh
./deploy/deploy.sh upgrade prune-generations
./deploy/deploy.sh upgrade prune-generations --apply --approve-plan-hash <plan_hash>
```

Windows 使用相同宿主实现与恢复目录。

```powershell
./deploy/deploy.ps1 upgrade prune-generations
./deploy/deploy.ps1 upgrade prune-generations -PruneApply -ApprovePlanHash <plan_hash>
```

预览与执行都持有既有 upgrade.lock，与维护升级、回滚和自动升级互斥。apply 读取已保存计划及匹配审批 hash。预览包含数据库身份和大小，无密码或环境配置。现有维护管理员凭据仅经既有 SQL transport 的 stdin 使用。清理不要求管理 API token，没有 schema 变更。

## 保留集与删除证明

当前配置数据库始终保留。每轮盘点通过绑定 Compose 项目的 `ps --all -q` 和真实容器 inspect，收集运行中及已停止待重启容器的 DATABASE_URL / DEEPSONAR_DATABASE_NAME 并加入保留集。端点、项目标记或环境无法核对时拒绝。即使旧容器指向 A 而当前配置为 D，且 A 没有连接，A 仍保留。只有未归档 journal 为 complete 且其 candidate 等于当前配置，才能证明最近完成当前升级的恢复源。该 source 取绑定 identity 的 saved.source.database，始终保留。rollbackGeneration 是激活身份。

所有未结束、未知状态及孤立 identity 的 source/candidate 都加入保留集。旧归档完成记录提供历史归属，其 source 不自动成为永久保留引用。当前运行于已恢复源库、缺少当前完成权威或存在旧升级未决 journal 时，删除准入关闭。

候选名称严格接受 ds_upgrade_ 加 32 位十六进制，或碰撞追加 8 位十六进制。删除须同时匹配宿主 operation、source、备份 SHA、cluster system identifier、rebuilt 数据库 marker 及数据库内 generation/runtime。owner 必须是正确 operation marker 的维护管理员。OID、marker hash、owner、cluster 和部署存储/引擎绑定冻结在计划里，apply 重新核对。

ACL 仅允许维护 owner、PUBLIC 的 TEMPORARY 和已封禁且无角色成员关系的本 operation runtime 的 CONNECT。未知 ACL/成员关系、可登录旧 runtime、其他可登录高权限角色都阻断删除。活动会话、prepared transaction、replication slot、subscription 或无法读取的数据库内状态均保留。新连接与 DROP 竞争时 PostgreSQL 拒绝删除。

此切片回收完成 rebuilt 且权限可证明的历史候选。中断 restore/rebuild、被 rollback activation marker 替代及归属缺失的旧库会保留。普通业务库、restore/migtest 库、角色、identity、备份和凭据文件均不在删除集合。升级成功路径不自动调用 GC。

## 删除响应丢失与重试

每库依序持久化宿主 intent、向当前业务库追加 platform_upgrade.generation_prune_intent 审计、复验准入、持久化 dropping 凭据，再发送普通 DROP。无 FORCE 或会话终止。确证库已消失后记录 dropped 凭据和 platform_upgrade.generation_pruned 审计。审计按计划、数据库和动作去重。

响应丢失返回 PRUNE_DROP_UNCERTAIN，保留原预览与 receipt。使用原 hash 重试，只有同 cluster/deployment 的 dropping/dropped receipt 能解释的缺库才可完成对账。同名新 OID 返回 PRUNE_DATABASE_IDENTITY_CHANGED。未决时先用原计划完成对账或人工核查，再生成新预览。审计字节是删除前估算，实际磁盘回收受 PostgreSQL 和文件系统影响。

## 验收与边界

`pnpm ci:unit:platform-upgrade-maintenance` 调用规划/故障注入和 Shell、PowerShell 正常入口参数回归。`pnpm ci:integration:platform-upgrade` 在 Actions 的 DEEPSONAR_FENCE_PG_TEST=1 下创建独立随机名 PostgreSQL 容器，覆盖四代保留两代、追加 8 位碰撞名、真实 ACL、活动连接保留、审计、提交后丢失 DROP 响应、同名新 OID 和原计划恢复。只清理 fixture 自建容器。

当前未访问生产、执行生产 DROP、部署或测量实际容量收益。最终提交的完整 Actions 结果由 PR 记录。
