# 检查点业务文件权限恢复实施计划

> 执行方式为当前 Agent 在独立 worktree 实施。依据用户已给定的范围直接推进，验证只使用 GitHub Actions。

## 目标与契约

人工等待恢复后的 `./script` 应保留所有者执行能力。新 manifest 使用 v2，普通业务文件的必填 `mode` 只允许十进制 384 或 448，即八进制 0600 或 0700。捕获投影为 `0600 | (source_mode & 0100)`，其余源权限舍弃。原始 bits 不存储，避免将共享写、组执行或特殊权限作为恢复能力。旧 v1 和缺字段明确拒绝，不回填冻结历史。无需 SQL schema 变更。

恢复沿既有 RuntimeHost 上传入口，业务路径预检之后才上传。Python 从安全 shell 引用的 JSON argv 读取清单，逐层使用 dir_fd / O_NOFOLLOW，拒绝符号链接、硬链接和特殊文件。上传后经同样路径校验及内容大小/hash 核验，再用文件描述符设置精确 mode。已有秘密和平台目录排除规则同样适用。

## 文件与协作

- `human-checkpoint-files.ts` 负责版本、文件 schema、scanner 与恢复 helper。
- `human-checkpoint.ts` 只改 import、封存版本号、恢复上传循环接线。prepare/persist 由原生 Session Agent 负责。
- `human-checkpoint-files.test.ts` 复用既有 Actions 测试入口，增加真实 Linux scanner/上传/权限/执行往返和敌意路径测试。
- `human-continuation.integration.test.ts` 更新受控扫描夹具，核对真实恢复入口调用。
- 文档同步 FR-JOB-008、运行时与安全边界、追溯及专题/索引。

## 实施步骤

- [ ] 先提交真实 Linux 捕获权限回归，在 Draft PR 的现有 Actions 中观察缺少 mode 的红测。
- [ ] 提取复用文件 schema，捕获最小权限，封存 v2，加载时拒绝旧版本。
- [ ] 实现安全恢复 helper 并接回普通恢复入口，补旧版本/非法 mode、注入文件名、链接与秘密目录拒绝回归。
- [ ] 同步权威文档，静态核对、git diff --check，集中推送并转 Ready。
- [ ] 持续监控最终 SHA 全部适用 CI，失败按日志修复，交付独立 PR，Refs #1074。

## 核验重点

- 源 0644/0755/特殊位/共享可写文件只产生 0600/0700，不因原始权限放大恢复权限。
- 上传创建权限无论默认是什么，都以内容核验后的 fchmod 为准。
- 路径含引号、shell 替换字符保持字面量，越界或秘密路径在任何上传之前拒绝。
- 已有目标/父目录符号链接、硬链接、特殊文件拒绝，路径中途替换也不能让 chmod 跟随链接。
- chmod 或 hash 核验失败阻断 Agent 启动。旧清单只保留历史，不能恢复为缺省权限。

## 运行记录

规划与契约由本轮 Agent 在用户授权内选择。测试隔离真实文件系统，进程静止使用受控夹具，既有进程与 inotify 测试继续覆盖其独立边界。
